import fs from "fs";
import path from "path";
import { memoDir, normalizeAgent, nowIso, readJson, withLock, writeJsonAtomic } from "./store.ts";

// ── directed agent-to-agent messages ──────────────────────────────────────────
// Broadcast events (events.ts) are the public-address system; this is direct
// mail. A message has a sender, a recipient (an agent, "captain" = the human,
// or "all"), a kind, and a thread. Replies carry the originating thread id so
// conversations render as threads, not interleaved fragments.
//
// Storage mirrors events.ts: append-only NDJSON with a monotonically
// increasing seq, one locked line write per send. Per-agent read cursors live
// in cursors.json so "unread" is cheap and idempotent to compute.

const MESSAGES_FILE = "messages.ndjson";
const CURSORS_FILE = "cursors.json";

export const MESSAGE_KINDS = ["question", "info", "review-request", "review-reply"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export type AgentMessage = {
  seq: number;
  time: string;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  thread: number;
  blocking?: boolean;
};

type Cursors = Record<string, number>;

function messagesPath(repoPath: string): string {
  return path.join(memoDir(repoPath), MESSAGES_FILE);
}

function cursorsPath(repoPath: string): string {
  return path.join(memoDir(repoPath), CURSORS_FILE);
}

export function readAllMessages(repoPath: string): AgentMessage[] {
  const file = messagesPath(repoPath);
  if (!fs.existsSync(file)) {
    return [];
  }
  const messages: AgentMessage[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as AgentMessage);
    } catch {
      // A torn line can only be the final one (appends are locked); skip it.
    }
  }
  return messages;
}

export function sendMessage(
  repoPath: string,
  from: string,
  to: string,
  body: string,
  kind: MessageKind = "info",
  threadId?: number,
  blocking = false
): AgentMessage {
  const normalizedFrom = normalizeAgent(from);
  const normalizedTo = normalizeAgent(to);
  const normalizedBody = String(body ?? "").trim();
  if (!normalizedBody) {
    throw new Error("body cannot be empty");
  }
  if (!MESSAGE_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${MESSAGE_KINDS.join(", ")}`);
  }
  if (normalizedFrom === normalizedTo) {
    throw new Error("from and to cannot be the same agent");
  }
  if (blocking && kind !== "question") {
    throw new Error("only questions can be blocking");
  }

  return withLock(repoPath, "messages", () => {
    const existing = readAllMessages(repoPath);
    const seq = (existing.at(-1)?.seq ?? 0) + 1;

    let thread = seq;
    if (threadId !== undefined) {
      if (!existing.some((m) => m.thread === threadId)) {
        throw new Error(`Unknown thread: ${threadId}`);
      }
      thread = threadId;
    }

    const message: AgentMessage = {
      seq,
      time: nowIso(),
      from: normalizedFrom,
      to: normalizedTo,
      kind,
      body: normalizedBody,
      thread,
      ...(blocking ? { blocking: true } : {}),
    };
    fs.appendFileSync(messagesPath(repoPath), `${JSON.stringify(message)}\n`, "utf8");
    return message;
  });
}

export type Inbox = {
  messages: AgentMessage[];
  unread: number;
  cursor: number;
};

// An agent's inbox: everything addressed to it or to "all". Reading with
// mark_read (the default) advances the agent's cursor so subsequent
// unread-only reads return only new mail.
export function getMessages(
  repoPath: string,
  agent: string,
  unreadOnly = true,
  limit = 20,
  threadId?: number,
  markRead = true
): Inbox {
  const normalizedAgent = normalizeAgent(agent);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  return withLock(repoPath, "messages", () => {
    const all = readAllMessages(repoPath);
    const cursors = readJson<Cursors>(cursorsPath(repoPath), {});
    const cursor = cursors[normalizedAgent] ?? 0;

    let relevant: AgentMessage[];
    if (threadId !== undefined) {
      // Thread view: the whole conversation, regardless of addressee.
      relevant = all.filter((m) => m.thread === threadId);
    } else {
      relevant = all.filter(
        (m) => (m.to === normalizedAgent || m.to === "all") && m.from !== normalizedAgent
      );
      if (unreadOnly) {
        relevant = relevant.filter((m) => m.seq > cursor);
      }
    }

    const messages = relevant.slice(-limit);
    const highest = messages.at(-1)?.seq ?? cursor;

    let effectiveCursor = cursor;
    if (markRead && threadId === undefined && highest > cursor) {
      cursors[normalizedAgent] = highest;
      writeJsonAtomic(cursorsPath(repoPath), cursors);
      effectiveCursor = highest;
    }

    const unread = all.filter(
      (m) =>
        (m.to === normalizedAgent || m.to === "all") &&
        m.from !== normalizedAgent &&
        m.seq > effectiveCursor
    ).length;

    return { messages, unread, cursor: effectiveCursor };
  });
}

export function unreadCount(repoPath: string, agent: string): number {
  const normalizedAgent = normalizeAgent(agent);
  const cursors = readJson<Cursors>(cursorsPath(repoPath), {});
  const cursor = cursors[normalizedAgent] ?? 0;
  return readAllMessages(repoPath).filter(
    (m) => (m.to === normalizedAgent || m.to === "all") && m.from !== normalizedAgent && m.seq > cursor
  ).length;
}

// Recent conversation across all parties, for dashboards and get_context.
export function crosstalk(repoPath: string, lastN = 12): AgentMessage[] {
  return readAllMessages(repoPath).slice(-lastN);
}

// Open questions that never got a reply in their thread — surfaced so a
// blocked asker is visible on the dashboard and in get_context.
export function openQuestions(repoPath: string): AgentMessage[] {
  const all = readAllMessages(repoPath);
  return all.filter(
    (m) =>
      m.kind === "question" &&
      !all.some((reply) => reply.thread === m.thread && reply.seq > m.seq && reply.from !== m.from)
  );
}
