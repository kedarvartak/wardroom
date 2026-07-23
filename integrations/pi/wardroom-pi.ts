/* eslint-disable @typescript-eslint/no-explicit-any */
// ── wardroom crew membership for the pi coding agent ──────────────────────────
// Drop this file in `.pi/extensions/` (project) or `~/.pi/agent/extensions/`
// (global), with `wardroom` installed as a dependency of your project. Your pi
// session then becomes a first-class member of the wardroom crew working this
// checkout: it pulls tasks from the same board, holds the same file leases,
// reads and answers the same crew mail — alongside headless Claude/Codex
// workers run by `wardroom` in another terminal.
//
// Three integration layers:
//   tools     board/messaging/memory operations, callable by pi's LLM
//   guard     pi's `tool_call` event BLOCKS edits to files another agent
//             holds a lease on — enforcement, not advisory
//   context   `before_agent_start` injects the live board + crew brief;
//             /board and /crosstalk commands for the human
//
// Written against the pi extension API as of pi-mono main (2026-07):
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
// Field names on ctx/ui surfaces may need small adjustments as pi evolves.

import { Type } from "@sinclair/typebox";
import {
  checkFiles,
  claimNextTask,
  completeTask,
  crosstalk,
  failTask,
  getContext,
  getMessages,
  memoryBrief,
  planTasks,
  remember,
  renderBoard,
  sendMessage,
} from "wardroom/core";

const REPO = process.cwd();
const ME = process.env.WARDROOM_AGENT ?? "pi";

// Pi tools that write files, and the param that carries the path.
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "str_replace", "apply_patch"]);
const pathOf = (input: any): string | undefined => input?.path ?? input?.file_path ?? input?.filePath;

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

export default function wardroom(pi: any) {
  // ── tools ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "wardroom_context",
    label: "Wardroom context",
    description:
      "Situational snapshot of the shared checkout: latest session writedown, open tasks, active file leases, recent events. Call before planning or touching files.",
    parameters: Type.Object({}),
    async execute() {
      return text(getContext(REPO, 15));
    },
  });

  pi.registerTool({
    name: "wardroom_claim_next",
    label: "Claim next task",
    description:
      "Atomically claim the next runnable task from the crew board (dependencies done, files not leased by a peer). Leases its files to you. Never pick board work by hand — this is what stops two agents doing the same work.",
    parameters: Type.Object({}),
    async execute() {
      const claim = claimNextTask(REPO, ME);
      if (claim.status === "claimed")
        return text(`Claimed ${claim.task.id}: ${claim.task.title}\nFiles: ${claim.task.files.join(", ") || "none"}\n${claim.task.description}`);
      if (claim.status === "empty") return text(`Nothing claimable: ${claim.reason}`);
      return text(`All eligible tasks blocked by peers' leases: ${JSON.stringify(claim.blocked)}`);
    },
  });

  pi.registerTool({
    name: "wardroom_complete",
    label: "Complete task",
    description: "Mark your claimed task done with a result other agents can build on, releasing its file leases.",
    parameters: Type.Object({ task_id: Type.String(), result: Type.String() }),
    async execute(_id: string, params: any) {
      return text(`${completeTask(REPO, ME, params.task_id, params.result).id} done`);
    },
  });

  pi.registerTool({
    name: "wardroom_fail",
    label: "Fail task",
    description: "Return your claimed task as failed with the reason; releases its leases.",
    parameters: Type.Object({ task_id: Type.String(), reason: Type.String() }),
    async execute(_id: string, params: any) {
      return text(`${failTask(REPO, ME, params.task_id, params.reason).id} failed`);
    },
  });

  pi.registerTool({
    name: "wardroom_plan",
    label: "Plan tasks",
    description:
      "Add tasks to the shared board. Declare each task's file footprint (paths/globs) honestly — disjoint footprints run in parallel, overlapping ones serialize. Optional assignee directs a task to a specific agent (delegation).",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          title: Type.String(),
          description: Type.Optional(Type.String()),
          files: Type.Optional(Type.Array(Type.String())),
          depends_on: Type.Optional(Type.Array(Type.String())),
          assignee: Type.Optional(Type.String()),
        })
      ),
    }),
    async execute(_id: string, params: any) {
      const { created } = planTasks(REPO, ME, params.tasks);
      return text(created.map((t) => `${t.id} ${t.title}${t.assignee ? ` @${t.assignee}` : ""}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "wardroom_send",
    label: "Message the crew",
    description:
      "Directed, threaded mail to a crew agent, 'captain' (the human) for decisions, or 'all'. Use kind=question when you need an answer; reply in the same thread_id.",
    parameters: Type.Object({
      to: Type.String(),
      body: Type.String(),
      kind: Type.Optional(Type.String()),
      thread_id: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const m = sendMessage(REPO, ME, params.to, params.body, (params.kind as any) ?? "info", params.thread_id);
      return text(`sent #${m.seq} -> ${m.to} (thread t${m.thread})`);
    },
  });

  pi.registerTool({
    name: "wardroom_inbox",
    label: "Read crew mail",
    description: "Unread messages addressed to you (marks them read). Answer questions before starting new work.",
    parameters: Type.Object({}),
    async execute() {
      const inbox = getMessages(REPO, ME);
      if (inbox.messages.length === 0) return text("(inbox empty)");
      return text(inbox.messages.map((m) => `#${m.seq} t${m.thread} from ${m.from} [${m.kind}]: ${m.body}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "wardroom_remember",
    label: "Propose crew memory",
    description:
      "Propose a durable decision/convention/gotcha every agent in this repo must respect. Injected into all future prompts (verified, footprint-scoped). Not for session notes or task results.",
    parameters: Type.Object({
      text: Type.String(),
      kind: Type.String(),
      files: Type.Optional(Type.Array(Type.String())),
      verify: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const item = remember(REPO, {
        text: params.text,
        kind: params.kind,
        source: ME,
        files: params.files,
        verify: params.verify,
      });
      return text(`remembered ${item.id} [${item.kind}] ${item.text}`);
    },
  });

  // ── guard: leases are ENFORCED inside pi ───────────────────────────────────
  pi.on("tool_call", async (event: any) => {
    if (!WRITE_TOOLS.has(event.toolName ?? event.name)) return;
    const file = pathOf(event.input);
    if (!file) return;
    const conflicts = checkFiles(REPO, ME, [file]);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      return {
        block: true,
        reason:
          `${file} is leased by ${c.holder} (${c.reason}, expires ${c.expires}). ` +
          `Do not edit it — take other work, or message ${c.holder} via wardroom_send.`,
      };
    }
  });

  // ── context: the board and the crew brief ride into every agent turn ───────
  pi.on("before_agent_start", async (event: any) => {
    const brief = memoryBrief(REPO);
    const extra = [
      "## Wardroom (shared checkout — you are one agent of a crew)",
      `You are "${ME}". Coordinate via the wardroom_* tools; claim before working, never edit files a peer has leased.`,
      brief ? `### Project brief — follow these\n${brief}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (typeof event?.appendSystemPrompt === "function") event.appendSystemPrompt(extra);
    else if (event && "systemPrompt" in event) event.systemPrompt = `${event.systemPrompt}\n\n${extra}`;
  });

  // ── human commands ─────────────────────────────────────────────────────────
  const show = (ctx: any, body: string) => {
    if (typeof ctx?.print === "function") ctx.print(body);
    else if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(body);
    else console.log(body);
  };

  pi.registerCommand("board", {
    description: "Show the wardroom task board",
    handler: async (_args: string, ctx: any) => show(ctx, renderBoard(REPO)),
  });

  pi.registerCommand("crosstalk", {
    description: "Recent crew messages",
    handler: async (_args: string, ctx: any) =>
      show(
        ctx,
        crosstalk(REPO, 15)
          .map((m) => `${m.from} -> ${m.to} [${m.kind}] ${m.body}`)
          .join("\n") || "(no crosstalk yet)"
      ),
  });
}
