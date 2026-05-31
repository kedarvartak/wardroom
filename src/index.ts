#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  appendMessage,
  getContext,
  getDecisions,
  readMemory,
  searchMemory,
  startSession,
  summarizeSession,
} from "./memory.js";
import { readMemo, writeSession } from "./writedown.js";

const server = new Server(
  { name: "multi-agent-memo", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

const tools = [
  {
    name: "start_session",
    description:
      "Open a new session block in the shared memory log. Call this once at the start of each working session before appending messages.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
        agent: { type: "string", description: "Agent name: claude, codex, or gemini." },
        persona: {
          type: "string",
          description: "Role for this session, e.g. coder, pm, architect, reviewer.",
        },
      },
      required: ["repo_path", "agent", "persona"],
    },
  },
  {
    name: "append_message",
    description:
      "Append a single message to the shared memory log. Use speaker='me' for user messages, or the agent name for agent messages.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
        agent: { type: "string", description: "Agent writing this message." },
        persona: { type: "string", description: "Persona active in this session." },
        speaker: { type: "string", description: "'me' for the user, or the agent name." },
        message: { type: "string", description: "The message content." },
      },
      required: ["repo_path", "agent", "persona", "speaker", "message"],
    },
  },
  {
    name: "read_memory",
    description:
      "Read the full shared memory log, optionally filtered to a specific agent's sections.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
        filter_agent: {
          type: "string",
          description: "Optional. Only return sections for this agent (claude, codex, gemini).",
        },
        filter_persona: {
          type: "string",
          description: "Optional. Only return messages for this persona.",
        },
      },
      required: ["repo_path"],
    },
  },
  {
    name: "get_context",
    description:
      "Return the last N messages from the log as a compact context block. Useful for injecting recent history at the start of a session.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
        last_n: {
          type: "integer",
          description: "Number of recent messages to return. Defaults to 20.",
        },
      },
      required: ["repo_path"],
    },
  },
  {
    name: "search_memory",
    description:
      "Search the shared memory log by keyword, with optional agent, persona, and tag filtering.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
        query: { type: "string", description: "Keyword query to search for." },
        limit: { type: "integer", description: "Maximum results to return. Defaults to 10." },
        filter_agent: { type: "string", description: "Optional. Only search this agent." },
        filter_persona: { type: "string", description: "Optional. Only search this persona." },
        filter_tag: {
          type: "string",
          enum: ["decision", "blocker", "todo"],
          description: "Optional. Only search entries containing this tag.",
        },
      },
      required: ["repo_path", "query"],
    },
  },
  {
    name: "summarize_session",
    description:
      "Summarize one session into participants, decisions, blockers, todos, and highlights.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
        session_date: {
          type: "string",
          description: "Optional. Session date in YYYY-MM-DD. Defaults to the latest session.",
        },
      },
      required: ["repo_path"],
    },
  },
  {
    name: "get_decisions",
    description:
      "Extract decision entries from the shared log using #decision tags and decision heuristics.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
        session_date: {
          type: "string",
          description: "Optional. Restrict to a single session date in YYYY-MM-DD.",
        },
        filter_agent: { type: "string", description: "Optional. Only include this agent." },
        filter_persona: { type: "string", description: "Optional. Only include this persona." },
      },
      required: ["repo_path"],
    },
  },
  {
    name: "write_session",
    description:
      "Manually capture the current chat as a structured session writedown. Triggered by the user (e.g. /writedown), not automatically. Writes a new file under .memo/sessions/ and regenerates AGENTS.md with the latest state. Provide a structured snapshot in `content` (summary, decisions, files touched, current state, next steps, blockers).",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the project repo." },
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
        repo_path: { type: "string", description: "Absolute path to the project repo." },
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
// Exposing AGENTS.md as an MCP resource lets clients that support proactive
// resource loading (e.g. Claude Code) fetch it automatically without a tool call.
// The URI encodes the repo_path so the client can request a specific project.

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "memo://agents-md",
      name: "AGENTS.md — shared agent memory",
      description:
        "The full shared memory log for this project. Read this at session start to understand prior decisions and context from all agents.",
      mimeType: "text/markdown",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (!uri.startsWith("memo://agents-md")) {
    throw new Error(`Unknown resource: ${uri}`);
  }
  // repo_path passed as query param: memo://agents-md?path=/abs/path/to/repo
  const repoPath = new URL(uri.replace("memo://", "http://placeholder/")).searchParams.get("path");
  if (!repoPath) {
    return {
      contents: [{ uri, mimeType: "text/plain", text: "Provide ?path=/absolute/repo/path" }],
    };
  }
  const content = readMemory(repoPath);
  return { contents: [{ uri, mimeType: "text/markdown", text: content }] };
});

// ── tools ─────────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    if (name === "start_session") {
      const parsed = z
        .object({ repo_path: z.string(), agent: z.string(), persona: z.string() })
        .parse(args);
      result = startSession(parsed.repo_path, parsed.agent, parsed.persona);
    } else if (name === "append_message") {
      const parsed = z
        .object({
          repo_path: z.string(),
          agent: z.string(),
          persona: z.string(),
          speaker: z.string(),
          message: z.string(),
        })
        .parse(args);
      result = appendMessage(
        parsed.repo_path,
        parsed.agent,
        parsed.persona,
        parsed.speaker,
        parsed.message
      );
    } else if (name === "read_memory") {
      const parsed = z
        .object({
          repo_path: z.string(),
          filter_agent: z.string().optional(),
          filter_persona: z.string().optional(),
        })
        .parse(args);
      result = readMemory(parsed.repo_path, parsed.filter_agent, parsed.filter_persona);
    } else if (name === "get_context") {
      const parsed = z
        .object({ repo_path: z.string(), last_n: z.number().int().positive().optional() })
        .parse(args);
      result = getContext(parsed.repo_path, parsed.last_n ?? 20);
    } else if (name === "search_memory") {
      const parsed = z
        .object({
          repo_path: z.string(),
          query: z.string(),
          limit: z.number().int().positive().optional(),
          filter_agent: z.string().optional(),
          filter_persona: z.string().optional(),
          filter_tag: z.enum(["decision", "blocker", "todo"]).optional(),
        })
        .parse(args);
      result = searchMemory(
        parsed.repo_path,
        parsed.query,
        parsed.limit ?? 10,
        parsed.filter_agent,
        parsed.filter_persona,
        parsed.filter_tag
      );
    } else if (name === "summarize_session") {
      const parsed = z
        .object({ repo_path: z.string(), session_date: z.string().optional() })
        .parse(args);
      result = summarizeSession(parsed.repo_path, parsed.session_date);
    } else if (name === "get_decisions") {
      const parsed = z
        .object({
          repo_path: z.string(),
          session_date: z.string().optional(),
          filter_agent: z.string().optional(),
          filter_persona: z.string().optional(),
        })
        .parse(args);
      result = getDecisions(
        parsed.repo_path,
        parsed.session_date,
        parsed.filter_agent,
        parsed.filter_persona
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
