import { execFileSync } from "child_process";
import { parseClaudeLine } from "./adapters/claude.ts";
import { parseCodexLine } from "./adapters/codex.ts";
import { parseGeminiLine } from "./adapters/gemini.ts";
import { spawnCli } from "./adapters/runner.ts";
import type { LineParser } from "./adapters/types.ts";
import type { WardroomConfig } from "./config.ts";
import { parseTaskPlan } from "./planner.ts";
import { listTasks, planTasks, type Task, type TaskInput } from "./tasks.ts";

// ── conductor ─────────────────────────────────────────────────────────────────
// The lead you talk to. Each command you type is interpreted here into work
// that gets appended to the LIVE board — not a plan you approve up front. The
// conductor sees the current board (so it extends rather than duplicates) and
// the crew roster (so it can dispatch a task straight to a specific agent). The
// agents then execute and delegate among themselves via the board.

const PARSERS: Record<string, LineParser> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  gemini: parseGeminiLine,
};

function conductorName(config: WardroomConfig): string {
  return config.conductor || config.planner;
}

function repoMap(repoPath: string, limit = 150): string {
  try {
    const files = execFileSync("git", ["ls-files"], { cwd: repoPath, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    return files.slice(0, limit).join("\n") + (files.length > limit ? `\n... +${files.length - limit} more` : "");
  } catch {
    return "(not a git repo)";
  }
}

function boardSummary(repoPath: string): string {
  const tasks = listTasks(repoPath).filter((t) => t.status !== "done" && t.status !== "failed");
  if (tasks.length === 0) return "(board is empty)";
  return tasks
    .map((t) => `${t.id} [${t.status}${t.assignee ? ` @${t.assignee}` : ""}] ${t.title} — files: ${t.files.join(", ") || "none"}`)
    .join("\n");
}

function conductorPrompt(command: string, crew: string[], repoPath: string): string {
  return [
    `You are the conductor of a crew of coding agents (${crew.join(", ")}) sharing one checkout.`,
    `The captain just gave you a command. Turn it into tasks for the crew and STOP.`,
    ``,
    `## Command`,
    command,
    ``,
    `## Current open board (extend it; do not recreate existing tasks)`,
    boardSummary(repoPath),
    ``,
    `## Repository files`,
    repoMap(repoPath),
    ``,
    `## Rules`,
    `- Emit only the NEW tasks this command requires.`,
    `- Make tasks file-disjoint where possible so the crew can run them in parallel;`,
    `  declare each task's "files" (paths or globs).`,
    `- Optionally set "assignee" to dispatch a task to a specific agent (${crew.join(", ")});`,
    `  omit it to let any free agent pick it up.`,
    `- Use "depends_on" with existing task ids or "$0" positional refs for ordering.`,
    `- If the command needs no new work (a question, a status check), return [].`,
    ``,
    `## Output`,
    `Output ONLY a JSON array in a fenced \`\`\`json block:`,
    `[{"title":"...","description":"...","files":["src/x.ts"],"assignee":"codex","depends_on":["$0"]}]`,
  ].join("\n");
}

export type ConductorResult = { created: Task[]; note?: string };

// Interpret one command. Returns the tasks appended to the live board (possibly
// none — e.g. for a question the conductor decides needs no work).
export async function interpretCommand(
  repoPath: string,
  config: WardroomConfig,
  crew: string[],
  command: string
): Promise<ConductorResult> {
  const lead = conductorName(config);
  const agentConfig = config.agents[lead];
  if (!agentConfig) {
    throw new Error(`conductor "${lead}" is not defined in wardroom.json agents`);
  }
  const parser = PARSERS[agentConfig.adapter];
  const timeoutMs = config.taskTimeoutMinutes * 60_000;

  const spawned = spawnCli(
    agentConfig.bin,
    agentConfig.args,
    conductorPrompt(command, crew, repoPath),
    repoPath,
    timeoutMs,
    parser
  );

  const chunks: string[] = [];
  for await (const event of spawned.events) {
    if (event.kind === "text") chunks.push(event.text);
    else if (event.kind === "result" && !event.ok) {
      throw new Error(`conductor (${lead}) failed: ${event.summary}`);
    }
  }

  const text = chunks.join("\n");
  let tasks: TaskInput[] = [];
  try {
    tasks = parseTaskPlan(text);
  } catch {
    // The conductor decided no board work was needed (a question/ack). Surface
    // its prose back to the captain.
    return { created: [], note: text.replace(/\s+/g, " ").trim().slice(0, 400) || "(nothing to do)" };
  }

  const { created } = planTasks(repoPath, "conductor", tasks);
  return { created };
}
