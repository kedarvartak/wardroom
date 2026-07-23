import { execFileSync } from "child_process";
import { parseClaudeLine } from "./adapters/claude.ts";
import { parseCodexLine } from "./adapters/codex.ts";
import { parseGeminiLine } from "./adapters/gemini.ts";
import { spawnCli } from "./adapters/runner.ts";
import type { LineParser } from "./adapters/types.ts";
import type { WardroomConfig } from "./config.ts";
import type { TaskInput } from "./tasks.ts";

// ── planner ───────────────────────────────────────────────────────────────────
// Turns a one-line goal into a proposed task board. The planner agent (default
// claude) is invoked headlessly with the goal and a repo map, and asked to emit
// a JSON task list whose tasks declare file footprints and dependencies — the
// two fields that let the scheduler parallelize the board safely. Nothing is
// committed to the board here; the caller reviews/edits/approves first.

const PARSERS: Record<string, LineParser> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  gemini: parseGeminiLine,
};

function repoMap(repoPath: string, limit = 200): string {
  try {
    const files = execFileSync("git", ["ls-files"], { cwd: repoPath, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const shown = files.slice(0, limit);
    const more = files.length > limit ? `\n... and ${files.length - limit} more` : "";
    return shown.join("\n") + more;
  } catch {
    return "(not a git repo or git unavailable; footprints must be inferred from the goal)";
  }
}

function planningPrompt(goal: string, repoPath: string): string {
  return [
    `You are the planner for a crew of coding agents sharing one checkout.`,
    `Decompose this goal into a task board.`,
    ``,
    `## Goal`,
    goal,
    ``,
    `## Repository files`,
    repoMap(repoPath),
    ``,
    `## Rules`,
    `- Make tasks file-disjoint wherever possible: two tasks that touch the same`,
    `  file will be serialized, so split by file/concern to maximize parallelism.`,
    `- Declare each task's "files" (paths or globs it will modify). This is what`,
    `  lets the scheduler run non-overlapping tasks at once.`,
    `- Put shared contracts (types, interfaces, schemas) in an early task and make`,
    `  dependents reference it via "depends_on".`,
    `- Reference dependencies by position in THIS list: "$0" is the first task.`,
    ``,
    `## Output`,
    `Output ONLY a JSON array of tasks, in a fenced \`\`\`json block, shaped:`,
    `[{"title": "...", "description": "...", "files": ["src/x.ts"], "depends_on": ["$0"]}]`,
    `Keep it to the tasks needed for the goal. No prose outside the JSON block.`,
  ].join("\n");
}

// Extract the task array from the planner's output: prefer a fenced ```json
// block, fall back to the first bare JSON array in the text.
export function parseTaskPlan(text: string): TaskInput[] {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (text.match(/\[[\s\S]*\]/)?.[0] ?? "");
  if (!candidate.trim()) {
    throw new Error("planner produced no JSON task array");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`planner JSON did not parse: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("planner did not return a non-empty task array");
  }

  return parsed.map((raw, i) => {
    const t = raw as Record<string, unknown>;
    if (typeof t.title !== "string" || !t.title.trim()) {
      throw new Error(`planner task ${i} has no title`);
    }
    return {
      title: t.title.trim(),
      description: typeof t.description === "string" ? t.description : undefined,
      files: Array.isArray(t.files) ? t.files.map(String) : undefined,
      depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : undefined,
      assignee: typeof t.assignee === "string" ? t.assignee : undefined,
    };
  });
}

export type PlanHooks = {
  onText?: (text: string) => void;
};

export async function planFromGoal(
  repoPath: string,
  config: WardroomConfig,
  goal: string,
  hooks: PlanHooks = {}
): Promise<TaskInput[]> {
  const plannerName = config.planner;
  const agentConfig = config.agents[plannerName];
  if (!agentConfig) {
    throw new Error(`planner "${plannerName}" is not defined in wardroom.json agents`);
  }
  const parser = PARSERS[agentConfig.adapter];
  const timeoutMs = config.taskTimeoutMinutes * 60_000;

  const spawned = spawnCli(
    agentConfig.bin,
    agentConfig.args,
    planningPrompt(goal, repoPath),
    repoPath,
    timeoutMs,
    parser
  );

  const chunks: string[] = [];
  for await (const event of spawned.events) {
    if (event.kind === "text") {
      chunks.push(event.text);
      hooks.onText?.(event.text);
    } else if (event.kind === "result" && !event.ok) {
      throw new Error(`planner (${plannerName}) failed: ${event.summary}`);
    }
  }

  return parseTaskPlan(chunks.join("\n"));
}
