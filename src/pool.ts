import type { AgentEvent } from "./adapters/types.ts";
import { compact } from "./compact.ts";
import type { WardroomConfig } from "./config.ts";
import { changeSummary } from "./git.ts";
import { getTask, listTasks, requeueStaleClaims, type Task } from "./tasks.ts";
import { runWorker, type WorkerPhase, type WorkerResult } from "./worker.ts";
import { writeSession } from "./writedown.ts";

// ── the worker pool ───────────────────────────────────────────────────────────
// Runs one worker per configured agent concurrently against the SAME board.
// No special concurrency machinery is needed here: `claim_next_task` is already
// an atomic, file-locked operation, so N workers pulling at once can never take
// the same task or collide on a file — the core arbitrates. This module's job
// is orchestration and presentation state:
//
//   - requeue tasks orphaned by a prior crashed run (before starting),
//   - fan out workers and fold their events into a per-agent pane model a
//     live renderer can draw,
//   - capture a session writedown when the board drains.

const PANE_LINES = 3;

export type AgentPane = {
  agent: string;
  phase: WorkerPhase;
  taskId?: string;
  taskTitle?: string;
  lines: string[];
  tokens: number;
  completed: number;
  failed: number;
};

export type PoolState = {
  panes: AgentPane[];
  startedAt: number;
};

export type PoolResult = {
  agents: string[];
  completed: number;
  failed: number;
  reviewed: number;
  requeued: string[];
  driftTasks: number;
  tokens: number;
  costUsd: number;
  budgetStopped: boolean;
  outcomes: { agent: string; task: string; title: string; status: "done" | "failed"; summary: string }[];
  durationMs: number;
  writedownFile?: string;
};

export type PoolHooks = {
  // Called (frequently) whenever pane state changes; a live TTY renderer
  // debounces and redraws from this.
  onChange?: (state: PoolState) => void;
  // Per-event stream, for --no-tty interleaved line output.
  onLine?: (agent: string, taskId: string, event: AgentEvent) => void;
  onStatus?: (line: string) => void;
  // Structured lifecycle transitions, forwarded from each worker — the TUI
  // turns these into transcript lines (started/finished/failed).
  onPhase?: (agent: string, phase: WorkerPhase, task?: { id: string; title: string }) => void;
};

export type PoolOptions = {
  maxTasksPerAgent?: number;
  // Periodic orphan sweep during the run (ms). Off by default; healthy tasks
  // always hold a live lease so a sweep only recovers genuinely lost work.
  sweepMs?: number;
  // Set false to skip the end-of-run writedown (used by tests).
  writedown?: boolean;
  // Interactive sessions: keep workers alive on a drained board, waiting for
  // new/delegated tasks, until this returns false.
  keepAlive?: () => boolean;
  // Receives a controller for changing crew membership mid-run (slash
  // commands). Only meaningful with keepAlive.
  register?: (control: PoolControl) => void;
};

export type PoolControl = {
  // Spawn a worker for an agent already present in config.agents.
  addAgent: (name: string) => { ok: true } | { ok: false; error: string };
  // Stop an agent's worker: it finishes in-flight work, claims nothing new,
  // and leaves the crew. Its config entry survives for a later re-add.
  removeAgent: (name: string) => { ok: true } | { ok: false; error: string };
  agents: () => string[];
};

function pushLine(pane: AgentPane, text: string): void {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  pane.lines.push(clean.slice(0, 200));
  if (pane.lines.length > PANE_LINES) pane.lines.shift();
}

// Per-task footprint drift lines for the writedown: which declared paths were
// never actually touched (over-declaration), the signal for tuning planning.
function driftLines(repoPath: string): string[] {
  return listTasks(repoPath)
    .filter((t) => (t.drift?.length ?? 0) > 0)
    .map((t) => `- ${t.id} (${t.title}): declared but untouched — ${t.drift!.join(", ")}`);
}

function buildWritedown(repoPath: string, result: Omit<PoolResult, "writedownFile">): string {
  const lines = [
    `# Pool session — ${result.agents.join(", ")}`,
    "",
    "## Summary",
    `${result.completed} task(s) done, ${result.failed} failed in ${Math.round(result.durationMs / 1000)}s` +
      (result.reviewed > 0 ? `; ${result.reviewed} cross-agent review(s)` : "") +
      (result.tokens > 0 ? `; ${result.tokens} tokens${result.costUsd ? ` ($${result.costUsd.toFixed(4)})` : ""}` : "") +
      (result.budgetStopped ? "; STOPPED at budget cap (tasks may remain)" : "") +
      (result.requeued.length > 0 ? `; requeued ${result.requeued.length} orphaned task(s) at start` : ""),
    "",
    "## Outcomes",
    ...(result.outcomes.length > 0
      ? result.outcomes.map((o) => {
          const stat = changeSummary(getTask(repoPath, o.task)?.changes);
          return `- [${o.status}] ${o.task} (${o.agent}): ${o.title}${stat ? ` — ${stat}` : ""} — ${o.summary.slice(0, 160)}`;
        })
      : ["- (no tasks ran)"]),
    "",
    "## Footprint drift",
    ...(driftLines(repoPath).length > 0 ? driftLines(repoPath) : ["- none — declared footprints matched what was touched"]),
    "",
    "## Current state",
    `Board: ${listTasks(repoPath, "done").length} done, ${listTasks(repoPath, "failed").length} failed, ` +
      `${listTasks(repoPath, "pending").length} pending, ${listTasks(repoPath, "claimed").length} claimed.`,
  ];
  return lines.join("\n");
}

export async function runPool(
  repoPath: string,
  agentNames: string[],
  config: WardroomConfig,
  hooks: PoolHooks = {},
  options: PoolOptions = {}
): Promise<PoolResult> {
  if (agentNames.length === 0) {
    throw new Error("runPool needs at least one agent");
  }
  for (const name of agentNames) {
    if (!config.agents[name]) {
      throw new Error(`No agent "${name}" in wardroom.json (known: ${Object.keys(config.agents).join(", ")})`);
    }
  }

  // Keep the working logs bounded before a long run appends to them.
  compact(repoPath);
  const requeued = requeueStaleClaims(repoPath);

  const panes = new Map<string, AgentPane>();
  for (const name of agentNames) {
    panes.set(name, { agent: name, phase: "idle", lines: [], tokens: 0, completed: 0, failed: 0 });
  }
  const state: PoolState = { panes: [...panes.values()], startedAt: Date.now() };
  const notify = () => hooks.onChange?.(state);

  // Budget tracking. When a cap is hit, workers stop claiming NEW tasks; work
  // already in flight finishes, then the run ends with a writedown.
  let tokens = 0;
  let costUsd = 0;
  let budgetStopped = false;
  const overBudget = () => {
    if (!config.budget) return false;
    if (config.budget.tokens !== undefined && tokens >= config.budget.tokens) return true;
    if (config.budget.usd !== undefined && costUsd >= config.budget.usd) return true;
    return false;
  };
  const shouldStop = () => {
    if (overBudget()) {
      budgetStopped = true;
      return true;
    }
    return false;
  };

  let sweep: ReturnType<typeof setInterval> | undefined;
  if (options.sweepMs && options.sweepMs > 0) {
    sweep = setInterval(() => requeueStaleClaims(repoPath), options.sweepMs);
    if (typeof sweep.unref === "function") sweep.unref();
  }

  // ── dynamic membership ─────────────────────────────────────────────────────
  // Workers can join and leave mid-run (slash commands). `entries` only ever
  // grows — a removed worker's promise still resolves and its results still
  // count; `active` is the live roster.
  const entries: { name: string; promise: Promise<WorkerResult> }[] = [];
  const active = new Set<string>();
  const removed = new Set<string>();

  const workerHooks = {
    onPhase: (agent: string, phase: WorkerPhase, task?: { id: string; title: string }) => {
      const pane = panes.get(agent);
      if (!pane) return;
      pane.phase = phase;
      if (task) {
        pane.taskId = task.id;
        pane.taskTitle = task.title;
      }
      if (phase === "done") pane.completed += 1;
      if (phase === "failed") pane.failed += 1;
      if (phase === "idle" || phase === "waiting") {
        pane.taskId = undefined;
        pane.taskTitle = undefined;
      }
      hooks.onPhase?.(agent, phase, task);
      notify();
    },
    onEvent: (agent: string, task: Task, event: AgentEvent) => {
      const pane = panes.get(agent);
      if (!pane) return;
      if (event.kind === "text") pushLine(pane, event.text);
      else if (event.kind === "tool") pushLine(pane, event.detail);
      else if (event.kind === "usage") {
        if (event.tokens) {
          pane.tokens += event.tokens;
          tokens += event.tokens;
        }
        if (event.costUsd) costUsd += event.costUsd;
      }
      hooks.onLine?.(agent, task.id, event);
      notify();
    },
    onStatus: hooks.onStatus,
  };

  const spawn = (name: string): void => {
    removed.delete(name);
    active.add(name);
    if (!panes.has(name)) {
      const pane: AgentPane = { agent: name, phase: "idle", lines: [], tokens: 0, completed: 0, failed: 0 };
      panes.set(name, pane);
      state.panes.push(pane);
    }
    const promise = runWorker(
      repoPath,
      name,
      config,
      workerHooks,
      options.maxTasksPerAgent ?? Infinity,
      {
        peers: [...active].filter((peer) => peer !== name),
        shouldStop: () => shouldStop() || removed.has(name),
        keepAlive: options.keepAlive ? () => options.keepAlive!() && !removed.has(name) : undefined,
      }
    ).then((result) => {
      // A worker that exited (removed, or non-keep-alive drain) leaves the
      // live roster and the pane display.
      if (active.delete(name)) {
        panes.delete(name);
        state.panes = state.panes.filter((p) => p.agent !== name);
        notify();
      }
      return result;
    });
    entries.push({ name, promise });
    notify();
  };

  options.register?.({
    addAgent: (name) => {
      if (!config.agents[name]) return { ok: false, error: `no agent "${name}" in config` };
      if (active.has(name)) return { ok: false, error: `${name} is already on the crew` };
      spawn(name);
      return { ok: true };
    },
    removeAgent: (name) => {
      if (!active.has(name) || removed.has(name)) return { ok: false, error: `${name} is not on the crew` };
      if (active.size - removed.size <= 1) return { ok: false, error: "cannot drop the last crew member" };
      removed.add(name);
      return { ok: true };
    },
    agents: () => [...active].filter((n) => !removed.has(n)),
  });

  try {
    // Register the whole starting roster before spawning anyone, so every
    // initial worker sees the full peer list (review needs it). Later joiners
    // see the roster as of their spawn; earlier workers' peer lists are not
    // retroactively extended — a newcomer becomes reviewable, not a reviewer,
    // until the next session.
    for (const name of agentNames) active.add(name);
    for (const name of agentNames) spawn(name);

    // Await all workers; if the crew grew while awaiting, await again.
    let results: WorkerResult[] = [];
    for (;;) {
      const snapshot = [...entries];
      results = await Promise.all(snapshot.map((e) => e.promise));
      if (entries.length === snapshot.length) break;
    }

    const outcomes = results.flatMap((r) =>
      r.outcomes.map((o) => ({
        agent: r.agent,
        task: o.task.id,
        title: o.task.title,
        status: o.status,
        summary: o.summary,
      }))
    );

    const driftTasks = listTasks(repoPath).filter((t) => (t.drift?.length ?? 0) > 0).length;
    const result: PoolResult = {
      agents: [...new Set(entries.map((e) => e.name))],
      completed: results.reduce((sum, r) => sum + r.completed, 0),
      failed: results.reduce((sum, r) => sum + r.failed, 0),
      reviewed: results.reduce((sum, r) => sum + r.reviewed, 0),
      requeued,
      driftTasks,
      tokens,
      costUsd,
      budgetStopped,
      outcomes,
      durationMs: Date.now() - state.startedAt,
    };

    if (options.writedown !== false && result.completed + result.failed > 0) {
      const written = writeSession(
        repoPath,
        "wardroom",
        "conductor",
        buildWritedown(repoPath, result),
        `Pool run: ${result.completed} done / ${result.failed} failed (${agentNames.join(", ")})`
      );
      result.writedownFile = written.file;
    }

    return result;
  } finally {
    if (sweep) clearInterval(sweep);
  }
}
