#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendMessage, getContext, readMemory, startSession } from "./memory.ts";

const server = new Server(
  { name: "multi-agent-memo", version: "0.1.0" },
  { capabilities: { tools: {} } }
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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string | Record<string, unknown>;

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
