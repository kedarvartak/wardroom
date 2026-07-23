import { interpretCommand, type ConductorResult } from "./conductor.ts";
import {
  agentPreset,
  saveConfig,
  vendorFor,
  VENDORS,
  type ReviewPolicy,
  type Vendor,
  type WardroomConfig,
} from "./config.ts";
import { runPool, type PoolControl, type PoolResult, type PoolState } from "./pool.ts";

// ── interactive session ───────────────────────────────────────────────────────
// Wraps the worker pool in a long-lived controller for the console. The pool
// runs in keep-alive mode, so the crew stays on the bridge with an empty board,
// waiting for work. `command()` runs the conductor to append tasks (the live
// workers pick them up); `stop()` drains and ends the session with a writedown.
//
// The session is also where slash-command control lands: crew membership
// changes go live through the pool's controller AND persist to wardroom.json,
// so `/add claude-2` outlives the session.

export type SessionHooks = {
  onChange?: (state: PoolState) => void;
  onLine?: (agent: string, taskId: string, event: import("./adapters/types.ts").AgentEvent) => void;
  onStatus?: (line: string) => void;
  onPhase?: (agent: string, phase: import("./worker.ts").WorkerPhase, task?: { id: string; title: string }) => void;
};

export type ControlResult = { ok: true; detail: string } | { ok: false; error: string };

export type Session = {
  command: (text: string) => Promise<ConductorResult>;
  stop: () => Promise<PoolResult>;
  crew: () => string[];
  config: WardroomConfig;
  addAgent: (name: string, vendor?: string) => ControlResult;
  removeAgent: (name: string) => ControlResult;
  setConductor: (name: string) => ControlResult;
  setReview: (policy: string) => ControlResult;
};

export function startSession(
  repoPath: string,
  crew: string[],
  config: WardroomConfig,
  hooks: SessionHooks = {}
): Session {
  let running = true;
  let control: PoolControl | undefined;

  // The pool promise resolves only when keepAlive flips false (i.e. stop()).
  const poolPromise = runPool(
    repoPath,
    crew,
    config,
    { onChange: hooks.onChange, onLine: hooks.onLine, onStatus: hooks.onStatus, onPhase: hooks.onPhase },
    {
      sweepMs: 10_000,
      keepAlive: () => running,
      writedown: true,
      register: (c) => {
        control = c;
      },
    }
  );

  const liveCrew = () => control?.agents() ?? crew;

  return {
    crew: liveCrew,
    config,
    command: (text: string) => interpretCommand(repoPath, config, liveCrew(), text),
    stop: async () => {
      running = false;
      return poolPromise;
    },

    addAgent: (name, vendor) => {
      if (!control) return { ok: false, error: "session is not ready yet" };
      if (!config.agents[name]) {
        const family = (vendor as Vendor | undefined) ?? vendorFor(name);
        if (!family || !VENDORS.includes(family)) {
          return {
            ok: false,
            error: `unknown vendor for "${name}" — use /add ${name} <${VENDORS.join("|")}> or name it like claude-2`,
          };
        }
        config.agents[name] = agentPreset(family);
      }
      const result = control.addAgent(name);
      if (!result.ok) return result;
      saveConfig(repoPath, config);
      return { ok: true, detail: `${name} joined the crew (${config.agents[name].adapter} adapter, saved to wardroom.json)` };
    },

    removeAgent: (name) => {
      if (!control) return { ok: false, error: "session is not ready yet" };
      const result = control.removeAgent(name);
      if (!result.ok) return result;
      return { ok: true, detail: `${name} is standing down (finishes in-flight work first; config entry kept)` };
    },

    setConductor: (name) => {
      if (!config.agents[name]) return { ok: false, error: `no agent "${name}" in config — /add it first` };
      config.conductor = name;
      config.planner = name;
      saveConfig(repoPath, config);
      return { ok: true, detail: `${name} now conducts (and plans); saved to wardroom.json` };
    },

    setReview: (policy) => {
      if (!["off", "changed-files", "all"].includes(policy)) {
        return { ok: false, error: `review must be off, changed-files, or all` };
      }
      config.review = policy as ReviewPolicy;
      saveConfig(repoPath, config);
      return { ok: true, detail: `review policy is now "${policy}"; saved to wardroom.json` };
    },
  };
}
