import { interpretCommand, type ConductorResult } from "./conductor.ts";
import type { WardroomConfig } from "./config.ts";
import { runPool, type PoolResult, type PoolState } from "./pool.ts";

// ── interactive session ───────────────────────────────────────────────────────
// Wraps the worker pool in a long-lived controller for the console. The pool
// runs in keep-alive mode, so the crew stays on the bridge with an empty board,
// waiting for work. `command()` runs the conductor to append tasks (the live
// workers pick them up); `stop()` drains and ends the session with a writedown.

export type SessionHooks = {
  onChange?: (state: PoolState) => void;
  onLine?: (agent: string, taskId: string, event: import("./adapters/types.ts").AgentEvent) => void;
  onStatus?: (line: string) => void;
};

export type Session = {
  command: (text: string) => Promise<ConductorResult>;
  stop: () => Promise<PoolResult>;
  crew: string[];
};

export function startSession(
  repoPath: string,
  crew: string[],
  config: WardroomConfig,
  hooks: SessionHooks = {}
): Session {
  let running = true;

  // The pool promise resolves only when keepAlive flips false (i.e. stop()).
  const poolPromise = runPool(
    repoPath,
    crew,
    config,
    { onChange: hooks.onChange, onLine: hooks.onLine, onStatus: hooks.onStatus },
    { sweepMs: 10_000, keepAlive: () => running, writedown: true }
  );

  return {
    crew,
    command: (text: string) => interpretCommand(repoPath, config, crew, text),
    stop: async () => {
      running = false;
      return poolPromise;
    },
  };
}
