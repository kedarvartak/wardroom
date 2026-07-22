#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { checkFiles, claimFiles, releaseFiles } from "./claims.ts";
import { getContext } from "./context.ts";
import { getEvents, postEvent } from "./events.ts";
import {
  claimNextTask,
  completeTask,
  failTask,
  planTasks,
  releaseTask,
  renderBoard,
} from "./tasks.ts";
import { readMemo, writeSession } from "./writedown.ts";

// wardroom v0.2 — a coordination server for parallel AI coding agents
// sharing ONE repository checkout (no worktrees). Three subsystems:
//
//   coordination  claims.ts + tasks.ts + events.ts — file leases, a
//                 dependency/file-overlap-aware task board, and an event bus.
//   memory        writedown.ts — user-triggered session snapshots, with
//                 AGENTS.md as the generated cold-start index.
//   context       context.ts — one call that merges both for a joining agent.

const server = new Server(
  { name: "wardroom", version: "0.2.0" },
  { capabilities: { tools: {}, resources: {} } }
);

const repoPathProp = {
  repo_path: { type: "string", description: "Absolute path to the project repo." },
} as const;

const agentProp = {
  agent: { type: "string", description: "Agent name, e.g. claude, codex, gemini." },
} as const;

const tools = [
  // ── context ────────────────────────────────────────────────────────────────
  {
    name: "get_context",
    description:
      "One-call situational snapshot for an agent joining the checkout: latest session writedown, open tasks, active file claims, and recent events. Call this before planning or touching files.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        last_events: {
          type: "integer",
          description: "How many recent events to include. Defaults to 15.",
        },
      },
      required: ["repo_path"],
    },
  },
  // ── task board ─────────────────────────────────────────────────────────────
  {
    name: "plan_tasks",
    description:
      "Add tasks to the shared board. Each task should declare the files it expects to touch (paths or globs) — that is what lets the scheduler run non-overlapping tasks in parallel and serialize colliding ones. Use depends_on with task ids or positional refs ('$0' = first task in this batch) for ordering.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        ...agentProp,
        tasks: {
          type: "array",
          description: "Tasks to create.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short task title." },
              description: { type: "string", description: "What to do and how to verify it." },
              files: {
                type: "array",
                items: { type: "string" },
                description:
                  "Files/globs this task will touch, e.g. ['src/auth/**', 'test/auth.test.ts']. Empty = touches nothing (research/review).",
              },
              depends_on: {
                type: "array",
                items: { type: "string" },
                description: "Task ids or '$<index>' refs into this batch that must finish first.",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["repo_path", "agent", "tasks"],
    },
  },
  {
    name: "claim_next_task",
    description:
      "Atomically pull the next runnable task: dependencies done AND declared files not leased by another agent. On success the task's files are auto-claimed for you. Returns 'all-blocked' with the blocking holders when every eligible task collides with an active claim.",
    inputSchema: {
      type: "object",
      properties: { ...repoPathProp, ...agentProp },
      required: ["repo_path", "agent"],
    },
  },
  {
    name: "complete_task",
    description:
      "Mark a task you claimed as done and release its file leases. Include a concise result other agents can build on.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        ...agentProp,
        task_id: { type: "string", description: "The task id, e.g. task-3." },
        result: { type: "string", description: "What was done, where, and how it was verified." },
      },
      required: ["repo_path", "agent", "task_id", "result"],
    },
  },
  {
    name: "fail_task",
    description: "Mark a task you claimed as failed and release its file leases.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        ...agentProp,
        task_id: { type: "string", description: "The task id." },
        reason: { type: "string", description: "Why it failed and what a retry needs to know." },
      },
      required: ["repo_path", "agent", "task_id", "reason"],
    },
  },
  {
    name: "release_task",
    description:
      "Return a claimed task to the board without completing it (or reset a failed task for retry). Releases its file leases.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        ...agentProp,
        task_id: { type: "string", description: "The task id." },
      },
      required: ["repo_path", "agent", "task_id"],
    },
  },
  {
    name: "get_board",
    description: "Render the full task board: every task with status, owner, dependencies, and files.",
    inputSchema: {
      type: "object",
      properties: { ...repoPathProp },
      required: ["repo_path"],
    },
  },
  // ── file claims ────────────────────────────────────────────────────────────
  {
    name: "claim_files",
    description:
      "Take an advisory lease on files/globs before editing them outside a board task. Re-claiming paths you hold renews the lease. Returns the conflicting holder instead when someone else has an overlapping claim — do NOT edit those files; pick other work or wait for expiry.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        ...agentProp,
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative files or globs to lease, e.g. ['src/api.ts', 'docs/**'].",
        },
        reason: { type: "string", description: "One line: what you are doing with these files." },
        ttl_minutes: {
          type: "integer",
          description: "Lease duration in minutes. Defaults to 15; max 240.",
        },
      },
      required: ["repo_path", "agent", "paths", "reason"],
    },
  },
  {
    name: "release_files",
    description:
      "Release your file leases the moment you finish editing — held leases serialize other agents. Releases all your claims, or one claim by id.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        ...agentProp,
        claim_id: { type: "string", description: "Optional. Release only this claim." },
      },
      required: ["repo_path", "agent"],
    },
  },
  {
    name: "check_files",
    description:
      "List active leases, and — if paths are given — which of them would conflict with those paths. Read-only; use before deciding what to work on.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional paths/globs to test for conflicts.",
        },
      },
      required: ["repo_path"],
    },
  },
  // ── events ─────────────────────────────────────────────────────────────────
  {
    name: "post_event",
    description:
      "Broadcast a note to other agents on this checkout (e.g. 'renamed UserService → AccountService; update imports before building'). Task lifecycle events are posted automatically; use this for everything else worth knowing mid-flight.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        ...agentProp,
        type: {
          type: "string",
          description: "Short kebab-case event type, e.g. note, heads-up, api-change.",
        },
        message: { type: "string", description: "The announcement." },
        data: { type: "object", description: "Optional structured payload." },
      },
      required: ["repo_path", "agent", "type", "message"],
    },
  },
  {
    name: "get_events",
    description:
      "Poll the shared event stream. Pass the cursor from your previous call as since_seq so you only see new events. Poll between tasks and before editing shared surfaces.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        since_seq: {
          type: "integer",
          description: "Return only events with seq greater than this. Defaults to 0 (all).",
        },
        limit: { type: "integer", description: "Max events to return. Defaults to 50." },
        filter_agent: { type: "string", description: "Optional. Only this agent's events." },
        filter_type: { type: "string", description: "Optional. Only this event type." },
      },
      required: ["repo_path"],
    },
  },
  // ── memory (writedowns) ────────────────────────────────────────────────────
  {
    name: "write_session",
    description:
      "Manually capture the current chat as a structured session writedown. Triggered by the user (e.g. /writedown), not automatically. Writes a new file under .memo/sessions/ and regenerates AGENTS.md with the latest state. Provide a structured snapshot in `content` (summary, decisions, files touched, current state, next steps, blockers).",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        agent: { type: "string", description: "Agent writing the writedown: claude, codex, or gemini." },
        persona: { type: "string", description: "Role for this session, e.g. coder, architect, reviewer." },
        content: {
          type: "string",
          description:
            "The structured session snapshot as Markdown. Recommended sections: Summary, Decisions, Files touched, Current state, Next steps, Blockers.",
        },
        summary: {
          type: "string",
          description:
            "Optional one-line summary for the session index. Defaults to the first heading/line of content.",
        },
      },
      required: ["repo_path", "agent", "persona", "content"],
    },
  },
  {
    name: "read_memo",
    description:
      "Manually load prior context into the current chat. Triggered by the user (e.g. /readmemo). Returns the latest N session writedowns in full plus an index of all sessions on file. Use this at the start of a fresh chat to recover where work left off.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoPathProp,
        last_n: {
          type: "integer",
          description: "How many of the most recent writedowns to return in full. Defaults to 1.",
        },
      },
      required: ["repo_path"],
    },
  },
];

// ── resources ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "memo://agents-md",
      name: "AGENTS.md — shared agent memory index",
      description:
        "Generated cold-start file: latest writedown plus session index. Read at session start.",
      mimeType: "text/markdown",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (!uri.startsWith("memo://agents-md")) {
    throw new Error(`Unknown resource: ${uri}`);
  }
  const repoPath = new URL(uri.replace("memo://", "http://placeholder/")).searchParams.get("path");
  if (!repoPath) {
    return {
      contents: [{ uri, mimeType: "text/plain", text: "Provide ?path=/absolute/repo/path" }],
    };
  }
  const indexPath = path.join(repoPath, "AGENTS.md");
  const text = fs.existsSync(indexPath)
    ? fs.readFileSync(indexPath, "utf8")
    : "No AGENTS.md yet. Run /writedown to create one.";
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
});

// ── tools ─────────────────────────────────────────────────────────────────────

const taskInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  files: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    if (name === "get_context") {
      const parsed = z
        .object({ repo_path: z.string(), last_events: z.number().int().positive().optional() })
        .parse(args);
      result = getContext(parsed.repo_path, parsed.last_events ?? 15);
    } else if (name === "plan_tasks") {
      const parsed = z
        .object({ repo_path: z.string(), agent: z.string(), tasks: z.array(taskInputSchema) })
        .parse(args);
      result = planTasks(parsed.repo_path, parsed.agent, parsed.tasks);
    } else if (name === "claim_next_task") {
      const parsed = z.object({ repo_path: z.string(), agent: z.string() }).parse(args);
      result = claimNextTask(parsed.repo_path, parsed.agent);
    } else if (name === "complete_task") {
      const parsed = z
        .object({
          repo_path: z.string(),
          agent: z.string(),
          task_id: z.string(),
          result: z.string(),
        })
        .parse(args);
      result = completeTask(parsed.repo_path, parsed.agent, parsed.task_id, parsed.result);
    } else if (name === "fail_task") {
      const parsed = z
        .object({
          repo_path: z.string(),
          agent: z.string(),
          task_id: z.string(),
          reason: z.string(),
        })
        .parse(args);
      result = failTask(parsed.repo_path, parsed.agent, parsed.task_id, parsed.reason);
    } else if (name === "release_task") {
      const parsed = z
        .object({ repo_path: z.string(), agent: z.string(), task_id: z.string() })
        .parse(args);
      result = releaseTask(parsed.repo_path, parsed.agent, parsed.task_id);
    } else if (name === "get_board") {
      const parsed = z.object({ repo_path: z.string() }).parse(args);
      result = renderBoard(parsed.repo_path);
    } else if (name === "claim_files") {
      const parsed = z
        .object({
          repo_path: z.string(),
          agent: z.string(),
          paths: z.array(z.string()).nonempty(),
          reason: z.string(),
          ttl_minutes: z.number().int().positive().optional(),
        })
        .parse(args);
      result = claimFiles(
        parsed.repo_path,
        parsed.agent,
        parsed.paths,
        parsed.reason,
        parsed.ttl_minutes ?? 15
      );
    } else if (name === "release_files") {
      const parsed = z
        .object({ repo_path: z.string(), agent: z.string(), claim_id: z.string().optional() })
        .parse(args);
      result = releaseFiles(parsed.repo_path, parsed.agent, parsed.claim_id);
    } else if (name === "check_files") {
      const parsed = z
        .object({ repo_path: z.string(), paths: z.array(z.string()).optional() })
        .parse(args);
      result = checkFiles(parsed.repo_path, parsed.paths);
    } else if (name === "post_event") {
      const parsed = z
        .object({
          repo_path: z.string(),
          agent: z.string(),
          type: z.string(),
          message: z.string(),
          data: z.record(z.unknown()).optional(),
        })
        .parse(args);
      result = postEvent(parsed.repo_path, parsed.agent, parsed.type, parsed.message, parsed.data);
    } else if (name === "get_events") {
      const parsed = z
        .object({
          repo_path: z.string(),
          since_seq: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().optional(),
          filter_agent: z.string().optional(),
          filter_type: z.string().optional(),
        })
        .parse(args);
      result = getEvents(
        parsed.repo_path,
        parsed.since_seq ?? 0,
        parsed.limit ?? 50,
        parsed.filter_agent,
        parsed.filter_type
      );
    } else if (name === "write_session") {
      const parsed = z
        .object({
          repo_path: z.string(),
          agent: z.string(),
          persona: z.string(),
          content: z.string(),
          summary: z.string().optional(),
        })
        .parse(args);
      result = writeSession(
        parsed.repo_path,
        parsed.agent,
        parsed.persona,
        parsed.content,
        parsed.summary
      );
    } else if (name === "read_memo") {
      const parsed = z
        .object({ repo_path: z.string(), last_n: z.number().int().positive().optional() })
        .parse(args);
      result = readMemo(parsed.repo_path, parsed.last_n ?? 1);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
