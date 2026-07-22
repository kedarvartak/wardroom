import type { AgentEvent } from "./adapters/types.ts";
import type { WardroomConfig } from "./config.ts";
import { listTasks, requeueStaleClaims } from "./tasks.ts";
import { runWorker, type WorkerPhase } from "./worker.ts";
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
};

export type PoolOptions = {
  maxTasksPerAgent?: number;
  // Periodic orphan sweep during the run (ms). Off by default; healthy tasks
  // always hold a live lease so a sweep only recovers genuinely lost work.
  sweepMs?: number;
  // Set false to skip the end-of-run writedown (used by tests).
  writedown?: boolean;
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
      (result.requeued.length > 0 ? `; requeued ${result.requeued.length} orphaned task(s) at start` : ""),
    "",
    "## Outcomes",
    ...(result.outcomes.length > 0
      ? result.outcomes.map((o) => `- [${o.status}] ${o.task} (${o.agent}): ${o.title} — ${o.summary.slice(0, 200)}`)
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

  const requeued = requeueStaleClaims(repoPath);

  const panes = new Map<string, AgentPane>();
  for (const name of agentNames) {
    panes.set(name, { agent: name, phase: "idle", lines: [], tokens: 0, completed: 0, failed: 0 });
  }
  const state: PoolState = { panes: [...panes.values()], startedAt: Date.now() };
  const notify = () => hooks.onChange?.(state);

  let sweep: ReturnType<typeof setInterval> | undefined;
  if (options.sweepMs && options.sweepMs > 0) {
    sweep = setInterval(() => requeueStaleClaims(repoPath), options.sweepMs);
    if (typeof sweep.unref === "function") sweep.unref();
  }

  try {
    const results = await Promise.all(
      agentNames.map((name) =>
        runWorker(
          repoPath,
          name,
          config,
          {
            onPhase: (agent, phase, task) => {
              const pane = panes.get(agent)!;
              pane.phase = phase;
              if (task) {
                pane.taskId = task.id;
                pane.taskTitle = task.title;
              }
              if (phase === "done") pane.completed += 1;
              if (phase === "failed") pane.failed += 1;
              if (phase === "idle") {
                pane.taskId = undefined;
                pane.taskTitle = undefined;
              }
              notify();
            },
            onEvent: (agent, task, event) => {
              const pane = panes.get(agent)!;
              if (event.kind === "text") pushLine(pane, event.text);
              else if (event.kind === "tool") pushLine(pane, event.detail);
              else if (event.kind === "usage" && event.tokens) pane.tokens += event.tokens;
              hooks.onLine?.(agent, task.id, event);
              notify();
            },
            onStatus: hooks.onStatus,
          },
          options.maxTasksPerAgent ?? Infinity,
          { peers: agentNames.filter((peer) => peer !== name) }
        )
      )
    );

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
      agents: agentNames,
      completed: results.reduce((sum, r) => sum + r.completed, 0),
      failed: results.reduce((sum, r) => sum + r.failed, 0),
      reviewed: results.reduce((sum, r) => sum + r.reviewed, 0),
      requeued,
      driftTasks,
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
