import fs from "fs";
import path from "path";
import { memoDir, normalizeAgent, normalizeLabel, nowIso, withLock } from "./store.ts";

// ── event log ─────────────────────────────────────────────────────────────────
// An append-only NDJSON stream under `.memo/events.ndjson` — the message bus
// between agents working the same checkout. Task lifecycle changes are posted
// here automatically; agents can also post free-form notes ("heads up, I'm
// renaming UserService — pull the board before touching src/services/").
//
// Each event carries a monotonically increasing `seq`. Agents poll with
// `get_events(since_seq)` and remember the highest seq they've seen — a cursor,
// so repeated polls cost O(new events), not O(history). NDJSON keeps appends
// cheap (one locked line write) and the file greppable by humans.

const EVENTS_FILE = "events.ndjson";

export type MemoEvent = {
  seq: number;
  time: string;
  agent: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
};

function eventsPath(repoPath: string): string {
  return path.join(memoDir(repoPath), EVENTS_FILE);
}

function readEvents(repoPath: string): MemoEvent[] {
  const file = eventsPath(repoPath);
  if (!fs.existsSync(file)) {
    return [];
  }
  const events: MemoEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as MemoEvent);
    } catch {
      // A torn line can only be the final one (appends are locked); skip it.
    }
  }
  return events;
}

export function postEvent(
  repoPath: string,
  agent: string,
  type: string,
  message: string,
  data?: Record<string, unknown>
): MemoEvent {
  const normalizedAgent = normalizeAgent(agent);
  const normalizedType = normalizeLabel(type, "type").toLowerCase();
  const normalizedMessage = String(message ?? "").trim();
  if (!normalizedMessage) {
    throw new Error("message cannot be empty");
  }

  return withLock(repoPath, "events", () => {
    const existing = readEvents(repoPath);
    const event: MemoEvent = {
      seq: (existing.at(-1)?.seq ?? 0) + 1,
      time: nowIso(),
      agent: normalizedAgent,
      type: normalizedType,
      message: normalizedMessage,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };
    fs.appendFileSync(eventsPath(repoPath), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  });
}

export type GetEventsResult = {
  events: MemoEvent[];
  cursor: number;
  remaining: number;
};

export function getEvents(
  repoPath: string,
  sinceSeq = 0,
  limit = 50,
  filterAgent?: string,
  filterType?: string
): GetEventsResult {
  if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
    throw new Error("since_seq must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  const agent = filterAgent ? normalizeAgent(filterAgent) : undefined;
  const type = filterType ? filterType.toLowerCase() : undefined;

  const matched = readEvents(repoPath).filter((event) => {
    if (event.seq <= sinceSeq) return false;
    if (agent && event.agent !== agent) return false;
    if (type && event.type !== type) return false;
    return true;
  });

  const events = matched.slice(0, limit);
  return {
    events,
    cursor: events.at(-1)?.seq ?? sinceSeq,
    remaining: matched.length - events.length,
  };
}
