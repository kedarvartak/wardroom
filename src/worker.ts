import { execFile } from "child_process";
import { parseClaudeLine } from "./adapters/claude.ts";
import { parseCodexLine } from "./adapters/codex.ts";
import { parseGeminiLine } from "./adapters/gemini.ts";
import { spawnCli } from "./adapters/runner.ts";
import type { AgentEvent, LineParser } from "./adapters/types.ts";
import type { WardroomConfig } from "./config.ts";
import { getContext } from "./context.ts";
import { diffOf, footprintTelemetry } from "./git.ts";
import { getMessages } from "./messages.ts";
import {
  anyReviewsOutstanding,
  claimNextTask,
  completeTask,
  failTask,
  listTasks,
  pendingReviewFor,
  recordTelemetry,
  resolveReview,
  submitForReview,
  type ReviewVerdict,
  type Task,
} from "./tasks.ts";

// ── the worker loop ───────────────────────────────────────────────────────────
// One worker drives one agent CLI against the shared board:
//
//   claim_next_task -> assemble prompt (task + context + inbox) -> spawn the
//   CLI headlessly -> stream events -> verification gate -> complete/fail.
//
// The worker owns the task lifecycle; the agent CLI only does the work and
// narrates. That split is deliberate: completion is gated on the verification
// command actually passing, not on the model claiming success.

const PARSERS: Record<string, LineParser> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  gemini: parseGeminiLine,
};

export type WorkerPhase = "claimed" | "working" | "verifying" | "done" | "failed" | "waiting" | "idle";

export type WorkerHooks = {
  onEvent?: (agent: string, task: Task, event: AgentEvent) => void;
  onStatus?: (line: string) => void;
  // Structured lifecycle transitions, for pane-based renderers that need more
  // than free-text status lines.
  onPhase?: (agent: string, phase: WorkerPhase, task?: Task) => void;
};

export type TaskOutcome = {
  task: Task;
  status: "done" | "failed";
  summary: string;
};

export type WorkerResult = {
  agent: string;
  completed: number;
  failed: number;
  reviewed: number;
  outcomes: TaskOutcome[];
  stopped: string;
};

export type WorkerOptions = {
  // Other agents in this run, eligible to review this worker's tasks.
  peers?: string[];
};

function buildPrompt(repoPath: string, agent: string, task: Task): string {
  const inbox = getMessages(repoPath, agent, true, 10);
  const inboxBlock =
    inbox.messages.length > 0
      ? inbox.messages.map((m) => `- from ${m.from} [${m.kind}, thread t${m.thread}]: ${m.body}`).join("\n")
      : "(empty)";

  return [
    `You are "${agent}", one worker in a crew of coding agents sharing this checkout.`,
    `Complete the following task, then STOP. Do not start unrelated work.`,
    ``,
    `## Task ${task.id}: ${task.title}`,
    task.description || "(no further description)",
    ``,
    task.files.length > 0
      ? `Files you may modify (already leased to you): ${task.files.join(", ")}. Do not modify files outside this footprint.`
      : `This task modifies no files (research/review). Do not modify any files.`,
    ``,
    `## Unread messages addressed to you`,
    inboxBlock,
    ``,
    `## Shared context`,
    getContext(repoPath, 10),
    ``,
    `## Finish`,
    `End with a short summary: what you changed, where, and how you verified it.`,
  ].join("\n");
}

function runVerify(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim().slice(-1500) });
      }
    );
  });
}

function buildReviewPrompt(agent: string, task: Task): string {
  return [
    `You are "${agent}", reviewing another agent's work on a shared checkout.`,
    ``,
    `## Task under review — ${task.id}: ${task.title}`,
    task.description || "(no description)",
    task.files.length > 0 ? `Declared footprint: ${task.files.join(", ")}` : "Declares no file footprint.",
    ``,
    `## Author's summary`,
    task.result || "(none)",
    ``,
    `## Diff`,
    "```diff",
    (task.diff || "(no diff captured)").slice(0, 6000),
    "```",
    ``,
    `## Your job`,
    `Judge correctness and whether the change matches the task. Reply with one`,
    `line: "VERDICT: APPROVE" if it is good, or "VERDICT: REQUEST_CHANGES" if it`,
    `is wrong or incomplete, followed by a one-sentence reason.`,
  ].join("\n");
}

// Parse the reviewer's decision from its output. Defaults to request-changes on
// an unreadable verdict — safer to send back than to wave through unreviewed.
function parseVerdict(text: string): { verdict: ReviewVerdict; note: string } {
  const approve = /VERDICT:\s*APPROVE/i.test(text);
  const changes = /VERDICT:\s*REQUEST[_-]?CHANGES/i.test(text);
  const note = text.replace(/\s+/g, " ").trim().slice(-240) || "(no note)";
  if (approve && !changes) return { verdict: "approve", note };
  return { verdict: "request-changes", note };
}

async function drainCli(
  spawned: { events: AsyncIterable<AgentEvent> },
  agentName: string,
  task: Task,
  hooks: WorkerHooks
): Promise<{ ok: boolean; summary: string; text: string }> {
  let ok = false;
  let summary = "";
  const textTail: string[] = [];
  for await (const event of spawned.events) {
    hooks.onEvent?.(agentName, task, event);
    if (event.kind === "text") {
      textTail.push(event.text);
      if (textTail.length > 8) textTail.shift();
    } else if (event.kind === "result") {
      ok = event.ok;
      summary = event.summary;
    }
  }
  const text = textTail.join(" ");
  if (!summary || (ok && summary === "exited cleanly")) {
    summary = text.slice(-500) || summary || "(no output)";
  }
  return { ok, summary, text };
}

export async function runWorker(
  repoPath: string,
  agentName: string,
  config: WardroomConfig,
  hooks: WorkerHooks = {},
  maxTasks = Infinity,
  options: WorkerOptions = {}
): Promise<WorkerResult> {
  const agentConfig = config.agents[agentName];
  if (!agentConfig) {
    throw new Error(`No agent "${agentName}" in wardroom.json (known: ${Object.keys(config.agents).join(", ")})`);
  }
  const parser = PARSERS[agentConfig.adapter];
  const timeoutMs = config.taskTimeoutMinutes * 60_000;
  const status = hooks.onStatus ?? (() => {});
  const phase = hooks.onPhase ?? (() => {});

  const peers = (options.peers ?? []).filter((p) => p !== agentName);
  const reviewEnabled =
    (config.review === "changed-files" || config.review === "all") && peers.length > 0;
  let reviewCursor = 0;

  const result: WorkerResult = {
    agent: agentName,
    completed: 0,
    failed: 0,
    reviewed: 0,
    outcomes: [],
    stopped: "board drained",
  };

  while (result.completed + result.failed < maxTasks) {
    // 1. Review work assigned to me takes priority over claiming new tasks —
    //    a task waiting on review is blocking its author's pipeline.
    if (reviewEnabled) {
      const toReview = pendingReviewFor(repoPath, agentName);
      if (toReview) {
        status(`${agentName}: reviewing ${toReview.id}`);
        phase(agentName, "working", toReview);
        const reviewSpawn = spawnCli(
          agentConfig.bin,
          agentConfig.args,
          buildReviewPrompt(agentName, toReview),
          repoPath,
          timeoutMs,
          parser
        );
        const { text } = await drainCli(reviewSpawn, agentName, toReview, hooks);
        const { verdict, note } = parseVerdict(text);
        const resolved = resolveReview(repoPath, agentName, toReview.id, verdict, note);
        result.reviewed += 1;
        status(`${agentName}: review ${toReview.id} -> ${verdict}`);
        // The reviewer drives the task to its terminal state, so it owns the
        // count (the author's submit-for-review was not terminal).
        if (resolved.status === "done") {
          result.completed += 1;
          result.outcomes.push({ task: resolved, status: "done", summary: resolved.result ?? "approved" });
          phase(agentName, "done", resolved);
        } else if (resolved.status === "failed") {
          result.failed += 1;
          result.outcomes.push({ task: resolved, status: "failed", summary: resolved.result ?? "review failed" });
          phase(agentName, "failed", resolved);
        }
        continue;
      }
    }

    const claim = claimNextTask(repoPath, agentName);

    if (claim.status === "empty") {
      const pending = listTasks(repoPath, "pending").length;
      const claimed = listTasks(repoPath, "claimed").length;
      const reviewsLeft = reviewEnabled && anyReviewsOutstanding(repoPath);
      if (pending === 0 && claimed === 0 && !reviewsLeft) {
        result.stopped = "board drained";
      } else if (claimed > 0 || reviewsLeft) {
        // Another worker holds work our pending tasks depend on, or a task is
        // in review by a peer. Wait our turn.
        status(`${agentName}: waiting - ${reviewsLeft ? "reviews in flight" : claim.reason}`);
        phase(agentName, "waiting");
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      } else {
        result.stopped = `stuck: ${pending} pending task(s) with unsatisfiable dependencies (failed prerequisites?)`;
      }
      break;
    }

    if (claim.status === "all-blocked") {
      const holders = [...new Set(claim.blocked.flatMap((b) => b.conflicts.map((c) => c.holder)))];
      status(`${agentName}: all eligible tasks blocked by lease(s) held by ${holders.join(", ")}; waiting`);
      phase(agentName, "waiting");
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    const task = claim.task;
    status(`${agentName}: claimed ${task.id} - ${task.title}`);
    phase(agentName, "claimed", task);

    const prompt = buildPrompt(repoPath, agentName, task);
    phase(agentName, "working", task);
    const spawned = spawnCli(agentConfig.bin, agentConfig.args, prompt, repoPath, timeoutMs, parser);

    let agentOk = false;
    let agentSummary = "";
    const textTail: string[] = [];
    for await (const event of spawned.events) {
      hooks.onEvent?.(agentName, task, event);
      if (event.kind === "text") {
        textTail.push(event.text);
        if (textTail.length > 5) textTail.shift();
      } else if (event.kind === "result") {
        agentOk = event.ok;
        agentSummary = event.summary;
      }
    }
    // Adapters without a native result event synthesize a generic summary from
    // the exit code; the agent's own last words are more useful when we have them.
    if (!agentSummary || (agentOk && agentSummary === "exited cleanly")) {
      agentSummary = textTail.join(" ").slice(-500) || agentSummary || "(no output)";
    }

    let outcome: "done" | "failed";
    let detail: string;

    if (!agentOk) {
      outcome = "failed";
      detail = agentSummary;
    } else if (config.verify && task.files.length > 0) {
      status(`${agentName}: verifying ${task.id} (${config.verify})`);
      phase(agentName, "verifying", task);
      const verify = await runVerify(config.verify, repoPath, timeoutMs);
      if (verify.ok) {
        outcome = "done";
        detail = agentSummary;
      } else {
        outcome = "failed";
        detail = `verification failed (${config.verify}): ${verify.output.slice(-600)}`;
      }
    } else {
      outcome = "done";
      detail = agentSummary;
    }

    const telemetry = footprintTelemetry(repoPath, task.files);

    if (outcome === "done") {
      const shouldReview =
        reviewEnabled && (config.review === "all" || task.files.length > 0);
      if (shouldReview) {
        const reviewer = peers[reviewCursor % peers.length];
        reviewCursor += 1;
        const diff = diffOf(repoPath, task.files);
        submitForReview(repoPath, agentName, task.id, reviewer, detail.slice(0, 800), diff, telemetry);
        status(`${agentName}: ${task.id} -> review by ${reviewer}`);
        phase(agentName, "idle");
        continue; // not terminal for this worker; the reviewer resolves it
      }
      completeTask(repoPath, agentName, task.id, detail.slice(0, 800));
      recordTelemetry(repoPath, task.id, telemetry.actualFiles, telemetry.drift);
      result.completed += 1;
    } else {
      failTask(repoPath, agentName, task.id, detail.slice(0, 800));
      recordTelemetry(repoPath, task.id, telemetry.actualFiles, telemetry.drift);
      result.failed += 1;
    }
    result.outcomes.push({ task, status: outcome, summary: detail });
    status(`${agentName}: ${task.id} ${outcome}`);
    phase(agentName, outcome, task);
  }

  if (result.completed + result.failed >= maxTasks) {
    result.stopped = `reached max tasks (${maxTasks})`;
  }
  phase(agentName, "idle");
  return result;
}
