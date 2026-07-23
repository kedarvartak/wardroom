import { listTasks, type Task } from "./tasks.ts";

// ── parallelism stats ─────────────────────────────────────────────────────────
// Reads the board's timestamps and answers the only question that matters for
// scheduler work: how parallel was this run actually? Wall-clock vs serial
// work gives the realized speedup; per-agent busy time shows utilization;
// ready-wait shows scheduling latency (time a task sat runnable, unclaimed);
// the critical path is the run-time lower bound no amount of parallelism can
// beat. Everything derives from `created` / `claimedAt` / `updated` — nothing
// new is logged.

type FinishedTask = Task & { claimedAt: string };

export type AgentStat = { agent: string; tasks: number; busyMs: number; utilization: number };

export type BoardStats = {
  finished: number;
  unfinished: number;
  wallClockMs: number;
  serialMs: number;
  speedup: number;
  waits: { id: string; agent: string; title: string; waitMs: number; runMs: number }[];
  agents: AgentStat[];
  criticalPath: { ids: string[]; ms: number };
};

const ms = (iso: string): number => Date.parse(iso);

export function computeStats(tasks: Task[]): BoardStats | null {
  const finished = tasks.filter(
    (t): t is FinishedTask => (t.status === "done" || t.status === "failed") && !!t.claimedAt
  );
  if (finished.length === 0) return null;
  const byId = new Map(finished.map((t) => [t.id, t]));

  // A task is "ready" once created and all dependencies are done; its wait is
  // ready -> claimed (scheduling + overlap + no-free-agent latency combined).
  const readyAt = (t: FinishedTask): number =>
    Math.max(ms(t.created), ...t.dependsOn.map((d) => (byId.has(d) ? ms(byId.get(d)!.updated) : 0)));

  const waits = finished.map((t) => ({
    id: t.id,
    agent: t.agent ?? "?",
    title: t.title,
    waitMs: Math.max(0, ms(t.claimedAt) - readyAt(t)),
    runMs: Math.max(0, ms(t.updated) - ms(t.claimedAt)),
  }));

  const wallClockMs = Math.max(...finished.map((t) => ms(t.updated))) - Math.min(...finished.map((t) => ms(t.created)));
  const serialMs = waits.reduce((sum, w) => sum + w.runMs, 0);

  const perAgent = new Map<string, AgentStat>();
  for (const w of waits) {
    const s = perAgent.get(w.agent) ?? { agent: w.agent, tasks: 0, busyMs: 0, utilization: 0 };
    s.tasks += 1;
    s.busyMs += w.runMs;
    perAgent.set(w.agent, s);
  }
  for (const s of perAgent.values()) s.utilization = wallClockMs > 0 ? s.busyMs / wallClockMs : 0;

  // Critical path: the heaviest dependency chain by run time (memoized DFS).
  const memo = new Map<string, { ids: string[]; ms: number }>();
  const chain = (t: FinishedTask): { ids: string[]; ms: number } => {
    const hit = memo.get(t.id);
    if (hit) return hit;
    let best: { ids: string[]; ms: number } = { ids: [], ms: 0 };
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (!dep) continue;
      const c = chain(dep);
      if (c.ms > best.ms) best = c;
    }
    const run = Math.max(0, ms(t.updated) - ms(t.claimedAt));
    const out = { ids: [...best.ids, t.id], ms: best.ms + run };
    memo.set(t.id, out);
    return out;
  };
  let criticalPath: { ids: string[]; ms: number } = { ids: [], ms: 0 };
  for (const t of finished) {
    const c = chain(t);
    if (c.ms > criticalPath.ms) criticalPath = c;
  }

  return {
    finished: finished.length,
    unfinished: tasks.length - finished.length,
    wallClockMs,
    serialMs,
    speedup: wallClockMs > 0 ? serialMs / wallClockMs : 1,
    waits,
    agents: [...perAgent.values()].sort((a, b) => b.busyMs - a.busyMs),
    criticalPath,
  };
}

function fmtDur(msVal: number): string {
  const s = Math.round(msVal / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function renderStats(repoPath: string): string {
  const stats = computeStats(listTasks(repoPath));
  if (!stats) return "No finished tasks with timing data yet — run some work first.";

  const lines = [
    `# Parallelism report — ${stats.finished} finished task(s)` +
      (stats.unfinished > 0 ? ` (${stats.unfinished} not finished, excluded)` : ""),
    "",
    `wall-clock ${fmtDur(stats.wallClockMs)} · serial work ${fmtDur(stats.serialMs)} · speedup ${stats.speedup.toFixed(2)}x`,
    `critical path ${fmtDur(stats.criticalPath.ms)} (${stats.criticalPath.ids.join(" -> ") || "none"}) — the floor no parallelism can beat`,
    "",
    "## Agents",
    ...stats.agents.map(
      (a) => `- ${a.agent}: ${a.tasks} task(s), busy ${fmtDur(a.busyMs)}, utilization ${(a.utilization * 100).toFixed(0)}%`
    ),
    "",
    "## Tasks (ready-wait = sat runnable but unclaimed)",
    ...stats.waits.map((w) => `- ${w.id} @${w.agent}: wait ${fmtDur(w.waitMs)}, run ${fmtDur(w.runMs)} — ${w.title}`),
  ];
  return lines.join("\n");
}
