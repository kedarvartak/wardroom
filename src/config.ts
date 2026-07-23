import fs from "fs";
import path from "path";

// ── wardroom.json ─────────────────────────────────────────────────────────────
// Per-repo configuration for the harness. Everything CLI-specific (binary,
// flags, permission model) lives HERE and in the adapters — nothing above the
// adapter layer knows how a particular agent CLI is invoked.
//
// The permission flags in the defaults are deliberately conservative: workers
// get whatever the user configured, and adapters fail loudly when a CLI stalls
// waiting for interactive approval (see docs/plan.md, risks).

export type AgentConfig = {
  adapter: "claude" | "codex" | "gemini";
  bin: string;
  args: string[];
  role?: string;
};

export type ReviewPolicy = "off" | "changed-files" | "all";

export type WardroomConfig = {
  agents: Record<string, AgentConfig>;
  verify?: string;
  taskTimeoutMinutes: number;
  // Cross-agent review (Phase 4): "off" completes tasks directly; otherwise a
  // finished task is reviewed by a different agent before it counts as done.
  // "changed-files" reviews only tasks that touched files; "all" reviews every
  // task. Requires 2+ agents in the run (a task's author cannot review itself).
  review: ReviewPolicy;
  // Which agent decomposes goals in `wardroom plan`/`run "<goal>"`.
  planner: string;
  // The lead you talk to in the interactive console; it interprets your
  // commands into board tasks. Defaults to the planner if unset.
  conductor?: string;
  // Per-session budget. When exceeded, workers stop claiming NEW tasks (in-flight
  // tasks finish), and the run ends with a writedown. Omit for no cap.
  budget?: { tokens?: number; usd?: number };
};

const DEFAULTS: WardroomConfig = {
  agents: {
    claude: {
      adapter: "claude",
      bin: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose"],
    },
    codex: {
      adapter: "codex",
      bin: "codex",
      args: ["exec", "--json"],
    },
    gemini: {
      adapter: "gemini",
      bin: "gemini",
      args: ["-p"],
    },
  },
  taskTimeoutMinutes: 20,
  review: "off",
  planner: "claude",
};

export const VENDORS = ["claude", "codex", "gemini"] as const;
export type Vendor = (typeof VENDORS)[number];

// Vendor defaults, so a new roster entry needs only a name: `/add claude-2`
// clones the claude preset. Any name works when it starts with a vendor.
export function agentPreset(vendor: Vendor): AgentConfig {
  return structuredClone(DEFAULTS.agents[vendor]);
}

export function vendorFor(name: string): Vendor | undefined {
  const lower = name.toLowerCase();
  return VENDORS.find((v) => lower === v || lower.startsWith(`${v}-`) || lower.startsWith(`${v}_`));
}

// Persist the live config back to wardroom.json, preserving any fields in the
// file this version does not know about. This is what makes slash-command
// changes durable across sessions.
export function saveConfig(repoPath: string, config: WardroomConfig): void {
  const file = path.join(repoPath, "wardroom.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Missing or invalid file: write fresh.
  }
  const merged: Record<string, unknown> = {
    ...existing,
    agents: config.agents,
    taskTimeoutMinutes: config.taskTimeoutMinutes,
    review: config.review,
    planner: config.planner,
  };
  if (config.conductor !== undefined) merged.conductor = config.conductor;
  if (config.verify !== undefined) merged.verify = config.verify;
  if (config.budget !== undefined) merged.budget = config.budget;
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

export function loadConfig(repoPath: string): WardroomConfig {
  const file = path.join(repoPath, "wardroom.json");
  if (!fs.existsSync(file)) {
    return structuredClone(DEFAULTS);
  }

  let parsed: Partial<WardroomConfig>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`wardroom.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }

  // Roster: if wardroom.json lists agents, THOSE are the crew (we don't inject
  // the other built-in agents). Each named agent is filled in from the matching
  // built-in default, so `{ "claude": {} }` still gets claude's bin/args.
  let agents: Record<string, AgentConfig>;
  if (parsed.agents && Object.keys(parsed.agents).length > 0) {
    agents = {};
    for (const [name, a] of Object.entries(parsed.agents)) {
      agents[name] = { ...(DEFAULTS.agents[name] ?? {}), ...a } as AgentConfig;
    }
  } else {
    agents = structuredClone(DEFAULTS.agents);
  }

  const config: WardroomConfig = {
    ...structuredClone(DEFAULTS),
    ...parsed,
    agents,
  };

  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.bin || !agent.adapter) {
      throw new Error(`wardroom.json agent "${name}" needs "adapter" and "bin"`);
    }
    if (!["claude", "codex", "gemini"].includes(agent.adapter)) {
      throw new Error(`wardroom.json agent "${name}": unknown adapter "${agent.adapter}"`);
    }
  }

  if (!["off", "changed-files", "all"].includes(config.review)) {
    throw new Error(`wardroom.json: review must be "off", "changed-files", or "all"`);
  }

  return config;
}
