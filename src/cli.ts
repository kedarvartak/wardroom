#!/usr/bin/env node
import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { sendMessage, MESSAGE_KINDS, type MessageKind } from "./messages.ts";
import { planTasks, renderBoard, type TaskInput } from "./tasks.ts";
import { renderDashboard, renderLog } from "./renderer.ts";

// ── wardroom CLI ──────────────────────────────────────────────────────────────
// mcp | plan | run | watch | board | log | say. `plan`/`run "<goal>"` use the
// planner agent to decompose a goal; `run --agents` fans a worker pool at the
// board (optionally with cross-agent review, per wardroom.json).

const HELP = `wardroom - one terminal for parallel coding agents on one checkout

usage: wardroom <command> [options]

commands:
  mcp                     start the MCP server over stdio (wire this into
                          Claude Code / Codex / Gemini CLI configs)
  plan "<goal>" [--yes]   planner agent decomposes a goal into a task board;
  plan --from FILE        review/edit/approve before it is committed, or load
                          an edited plan (JSON task array) from FILE
  run --agents A[,B,...] ["<goal>"] [--max-tasks N] [--no-tty]
                          run a pool of workers (one per agent) at the board;
                          with a goal, plan+approve first
  watch                   live dashboard: board, claims, crosstalk, events
  board                   print the task board and exit
  log [-n N] [--follow]   merged events + messages timeline
  say <msg> [--to AGENT] [--kind KIND] [--thread N]
                          send a message as the captain (default to: all)
  guard --agent NAME      enforcement hook: reads a tool call on stdin and
                          blocks edits to files another agent has leased
  compact                 archive old events/messages/tasks under .memo/archive
  help                    show this help

The repo is the current working directory. State lives in ./.memo/.
`;

function repoPath(): string {
  const repo = process.cwd();
  if (!fs.existsSync(path.join(repo, ".git")) && !fs.existsSync(path.join(repo, ".memo"))) {
    process.stderr.write(`warning: ${repo} has no .git or .memo - is this the right directory?\n`);
  }
  return repo;
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  args.splice(idx, 2);
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

async function cmdWatch(repo: string): Promise<void> {
  const ALT_SCREEN_ON = "\x1b[?1049h";
  const ALT_SCREEN_OFF = "\x1b[?1049l";
  const CLEAR = "\x1b[2J\x1b[H";
  const memo = path.join(repo, ".memo");
  fs.mkdirSync(memo, { recursive: true });

  let last = "";
  const draw = () => {
    let frame: string;
    try {
      frame = renderDashboard(repo, process.stdout.columns ?? 78);
    } catch (error) {
      frame = `wardroom watch: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (frame !== last) {
      last = frame;
      process.stdout.write(CLEAR + frame + "\n");
    }
  };

  const cleanup = () => {
    process.stdout.write(ALT_SCREEN_OFF);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stdout.write(ALT_SCREEN_ON);
  draw();

  // fs.watch for sub-second reaction, interval as a safety net (fs.watch is
  // platform-flaky for atomic renames), light debounce to coalesce bursts.
  let pending: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      draw();
    }, 150);
  };
  try {
    fs.watch(memo, schedule);
  } catch {
    // fall back to interval-only
  }
  setInterval(draw, 1000);
}

async function cmdLog(repo: string, args: string[]): Promise<void> {
  const n = Number(flagValue(args, "-n") ?? 50);
  const follow = hasFlag(args, "--follow") || hasFlag(args, "-f");
  process.stdout.write(renderLog(repo, n) + "\n");
  if (!follow) return;

  let last = renderLog(repo, Number.MAX_SAFE_INTEGER);
  setInterval(() => {
    const current = renderLog(repo, Number.MAX_SAFE_INTEGER);
    if (current !== last) {
      const fresh = current.startsWith(last) ? current.slice(last.length).replace(/^\n/, "") : current;
      if (fresh.trim()) process.stdout.write(fresh + "\n");
      last = current;
    }
  }, 500);
}

async function cmdGuard(args: string[]): Promise<void> {
  const { runGuard } = await import("./guard.ts");
  const agent = flagValue(args, "--agent") ?? process.env.WARDROOM_AGENT;
  if (!agent) {
    throw new Error("usage: wardroom guard --agent <name>  (or set WARDROOM_AGENT)");
  }
  // repo comes from the hook payload's cwd (falls back to process.cwd()).
  process.exitCode = await runGuard(agent);
}

async function cmdCompact(repo: string): Promise<void> {
  const { compact } = await import("./compact.ts");
  const r = compact(repo, { minToCompact: 0 });
  process.stdout.write(
    `compacted: events ${r.events.archived} archived / ${r.events.kept} kept; ` +
      `messages ${r.messages.archived} archived / ${r.messages.kept} kept; ` +
      `tasks ${r.tasks.archived} archived / ${r.tasks.kept} kept\n`
  );
}

function cmdSay(repo: string, args: string[]): void {
  const to = flagValue(args, "--to") ?? "all";
  const kind = (flagValue(args, "--kind") ?? "info") as MessageKind;
  const threadRaw = flagValue(args, "--thread");
  const thread = threadRaw === undefined ? undefined : Number(threadRaw);
  const body = args.join(" ").trim();
  if (!body) {
    throw new Error('usage: wardroom say "<message>" [--to agent] [--kind ' + MESSAGE_KINDS.join("|") + "] [--thread N]");
  }
  const message = sendMessage(repo, "captain", to, body, kind, thread);
  process.stdout.write(`sent #${message.seq} captain -> ${message.to} (thread t${message.thread})\n`);
}

function poolSummary(result: {
  completed: number;
  failed: number;
  reviewed: number;
  requeued: string[];
  driftTasks: number;
  tokens: number;
  costUsd: number;
  budgetStopped: boolean;
  durationMs: number;
  writedownFile?: string;
}, agents: string[]): string {
  return (
    `${result.completed} done, ${result.failed} failed across ${agents.join(", ")} in ${Math.round(result.durationMs / 1000)}s` +
    (result.reviewed ? `; ${result.reviewed} review(s)` : "") +
    (result.requeued.length ? `; requeued ${result.requeued.length} orphaned` : "") +
    (result.driftTasks ? `; ${result.driftTasks} task(s) with footprint drift` : "") +
    (result.tokens ? `; ${result.tokens} tokens${result.costUsd ? ` ($${result.costUsd.toFixed(4)})` : ""}` : "") +
    (result.budgetStopped ? "; STOPPED at budget cap" : "") +
    (result.writedownFile ? `\nwritedown: ${result.writedownFile}` : "")
  );
}

function renderProposal(tasks: TaskInput[]): string {
  return tasks
    .map((t, i) => {
      const deps = t.depends_on?.length ? ` (after ${t.depends_on.join(", ")})` : "";
      const files = t.files?.length ? ` [${t.files.join(", ")}]` : " [no footprint]";
      return `  $${i}  ${t.title}${deps}${files}`;
    })
    .join("\n");
}

// Generate a plan for a goal and interactively approve / edit / regenerate it,
// returning the tasks to commit (or null if the user quit). Non-interactive
// (--yes or no TTY) auto-approves the first proposal.
async function proposeAndApprove(
  repo: string,
  goal: string,
  autoYes: boolean
): Promise<TaskInput[] | null> {
  const { loadConfig } = await import("./config.ts");
  const { planFromGoal } = await import("./planner.ts");
  const config = loadConfig(repo);

  for (;;) {
    process.stderr.write(`planning with ${config.planner}...\n`);
    const tasks = await planFromGoal(repo, config, goal);
    process.stdout.write(`\nProposed board (${tasks.length} tasks):\n${renderProposal(tasks)}\n\n`);

    const planFile = path.join(repo, ".memo", "plan.json");
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, JSON.stringify(tasks, null, 2) + "\n");

    if (autoYes || !process.stdin.isTTY) return tasks;

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question("[a]pprove / [e]dit / [r]egenerate / [q]uit? ")).trim().toLowerCase();
    rl.close();

    if (answer === "a" || answer === "") return tasks;
    if (answer === "r") continue;
    if (answer === "e") {
      process.stdout.write(
        `\nProposal written to ${path.relative(repo, planFile)}. Edit it, then:\n  wardroom plan --from ${path.relative(repo, planFile)}\n`
      );
      return null;
    }
    return null; // quit
  }
}

async function cmdPlan(repo: string, args: string[]): Promise<void> {
  const fromFile = flagValue(args, "--from");
  const autoYes = hasFlag(args, "--yes") || hasFlag(args, "-y");

  let tasks: TaskInput[];
  if (fromFile) {
    tasks = JSON.parse(fs.readFileSync(path.resolve(repo, fromFile), "utf8")) as TaskInput[];
  } else {
    const goal = args.join(" ").trim();
    if (!goal) throw new Error('usage: wardroom plan "<goal>" [--yes]  |  wardroom plan --from FILE');
    const approved = await proposeAndApprove(repo, goal, autoYes);
    if (!approved) {
      process.stdout.write("plan not committed\n");
      return;
    }
    tasks = approved;
  }

  const { created } = planTasks(repo, "captain", tasks);
  process.stdout.write(`committed ${created.length} task(s) to the board:\n`);
  process.stdout.write(renderBoard(repo) + "\n");
}

async function cmdRun(repo: string, args: string[]): Promise<void> {
  const { loadConfig } = await import("./config.ts");
  const { runPool } = await import("./pool.ts");
  const { renderPool } = await import("./renderer.ts");

  const autoYes = hasFlag(args, "--yes") || hasFlag(args, "-y");

  const noTty = hasFlag(args, "--no-tty") || hasFlag(args, "--plain");
  const agentsRaw = flagValue(args, "--agents");
  const maxTasks = Number(flagValue(args, "--max-tasks") ?? Infinity);
  if (!agentsRaw) {
    throw new Error('usage: wardroom run --agents <name>[,<name>...] ["<goal>"] [--max-tasks N] [--no-tty]');
  }
  const agents = agentsRaw.split(",").map((a) => a.trim()).filter(Boolean);
  const config = loadConfig(repo);

  // A trailing goal (any non-flag remainder) means: plan and approve first.
  const goal = args.join(" ").trim();
  if (goal) {
    const approved = await proposeAndApprove(repo, goal, autoYes);
    if (!approved) {
      process.stdout.write("plan not approved; nothing run\n");
      return;
    }
    planTasks(repo, "captain", approved);
  }

  const DIM = "\x1b[2m";
  const CYAN = "\x1b[36m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";

  const live = process.stdout.isTTY && !noTty;

  if (live) {
    const ALT_ON = "\x1b[?1049h";
    const ALT_OFF = "\x1b[?1049l";
    const CLEAR = "\x1b[2J\x1b[H";
    let latest = "";
    let dirty = true;
    const draw = () => {
      if (!dirty) return;
      dirty = false;
      process.stdout.write(CLEAR + latest + "\n");
    };
    const timer = setInterval(draw, 200);
    process.stdout.write(ALT_ON);
    const restore = () => {
      clearInterval(timer);
      process.stdout.write(ALT_OFF);
    };
    process.on("SIGINT", () => {
      restore();
      process.exit(130);
    });

    try {
      const result = await runPool(
        repo,
        agents,
        config,
        {
          onChange: (state) => {
            latest = renderPool(repo, state, process.stdout.columns ?? 88);
            dirty = true;
          },
        },
        { maxTasksPerAgent: maxTasks, sweepMs: 10_000 }
      );
      restore();
      process.stdout.write(poolSummary(result, agents) + "\n");
      if (result.failed > 0) process.exitCode = 1;
    } catch (error) {
      restore();
      throw error;
    }
    return;
  }

  // Non-TTY / --no-tty: interleaved labeled lines, loggable and CI-friendly.
  const result = await runPool(
    repo,
    agents,
    config,
    {
      onStatus: (line) => process.stdout.write(`${YELLOW}== ${line}${RESET}\n`),
      onLine: (agent, taskId, event) => {
        const tag = `${CYAN}[${agent} ${taskId}]${RESET}`;
        if (event.kind === "text") process.stdout.write(`${tag} ${event.text}\n`);
        else if (event.kind === "tool") process.stdout.write(`${tag} ${DIM}${event.detail}${RESET}\n`);
        else if (event.kind === "result")
          process.stdout.write(`${tag} ${event.ok ? "" : YELLOW}result: ${event.summary}${RESET}\n`);
      },
    },
    { maxTasksPerAgent: maxTasks, sweepMs: 10_000 }
  );
  process.stdout.write("\n" + poolSummary(result, agents) + "\n");
  if (result.failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "run":
      await cmdRun(repoPath(), args);
      return;
    case "plan":
      await cmdPlan(repoPath(), args);
      return;
    case "mcp": {
      const { runMcp } = await import("./mcp.ts");
      await runMcp();
      return; // keeps running on stdio
    }
    case "watch":
      await cmdWatch(repoPath());
      return;
    case "board":
      process.stdout.write(renderBoard(repoPath()) + "\n");
      return;
    case "log":
      await cmdLog(repoPath(), args);
      return;
    case "say":
      cmdSay(repoPath(), args);
      return;
    case "guard":
      await cmdGuard(args);
      return;
    case "compact":
      await cmdCompact(repoPath());
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      if (command === undefined) process.exitCode = 1;
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`wardroom: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
