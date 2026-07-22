import fs from "fs";
import path from "path";
import { memoDir, nowIso, readJson, withLock, writeJsonAtomic } from "./store.ts";

// ── compaction ────────────────────────────────────────────────────────────────
// The append-only logs (events, messages) and the task board grow without bound
// over a long session. Compaction archives old entries under `.memo/archive/`
// and keeps a recent tail live, so reads stay cheap and the working files stay
// small. It is safe with respect to the invariants the rest of the system
// relies on:
//
//   - Event/message seq numbers are per-line, so trimming old lines never
//     changes the remaining ones. The tail always retains the highest seq, so
//     the next append continues the sequence correctly (never restarts at 1)
//     and outstanding read-cursors keep working (they filter seq > cursor).
//   - Board compaction only archives terminal tasks (done/failed); active
//     tasks and the id counter are untouched.

const ARCHIVE_DIR = "archive";

export type CompactOptions = {
  keepEvents?: number; // default 500
  keepMessages?: number; // default 500
  keepDoneTasks?: number; // default 200
  minToCompact?: number; // only compact a log once it exceeds this (default 1000)
};

export type CompactResult = {
  events: { archived: number; kept: number };
  messages: { archived: number; kept: number };
  tasks: { archived: number; kept: number };
};

function archiveDir(repoPath: string): string {
  const dir = path.join(memoDir(repoPath), ARCHIVE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(): string {
  return nowIso().replace(/[:.]/g, "-");
}

function compactNdjson(
  repoPath: string,
  lockName: string,
  fileName: string,
  keep: number,
  minToCompact: number
): { archived: number; kept: number } {
  return withLock(repoPath, lockName, () => {
    const file = path.join(memoDir(repoPath), fileName);
    if (!fs.existsSync(file)) return { archived: 0, kept: 0 };
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length <= minToCompact) return { archived: 0, kept: lines.length };

    const cut = Math.max(0, lines.length - keep);
    const archived = lines.slice(0, cut);
    const kept = lines.slice(cut);

    fs.appendFileSync(
      path.join(archiveDir(repoPath), `${fileName}.${stamp()}`),
      archived.join("\n") + "\n",
      "utf8"
    );
    // Rewrite the live file atomically with just the tail.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, kept.join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { archived: archived.length, kept: kept.length };
  });
}

type Task = { status: string; updated?: string; [k: string]: unknown };
type TasksState = { nextId: number; tasks: Task[] };

function compactTasks(
  repoPath: string,
  keepDone: number,
  minToCompact: number
): { archived: number; kept: number } {
  return withLock(repoPath, "tasks", () => {
    const file = path.join(memoDir(repoPath), "tasks.json");
    const state = readJson<TasksState>(file, { nextId: 1, tasks: [] });
    const terminal = state.tasks.filter((t) => t.status === "done" || t.status === "failed");
    if (state.tasks.length <= minToCompact) return { archived: 0, kept: state.tasks.length };

    // Keep all active tasks plus the most recent `keepDone` terminal ones.
    terminal.sort((a, b) => String(a.updated ?? "").localeCompare(String(b.updated ?? "")));
    const toArchive = new Set(terminal.slice(0, Math.max(0, terminal.length - keepDone)));
    if (toArchive.size === 0) return { archived: 0, kept: state.tasks.length };

    const archived = [...toArchive];
    fs.appendFileSync(
      path.join(archiveDir(repoPath), `tasks.json.${stamp()}`),
      JSON.stringify(archived, null, 2) + "\n",
      "utf8"
    );
    state.tasks = state.tasks.filter((t) => !toArchive.has(t));
    writeJsonAtomic(file, state);
    return { archived: archived.length, kept: state.tasks.length };
  });
}

export function compact(repoPath: string, options: CompactOptions = {}): CompactResult {
  const keepEvents = options.keepEvents ?? 500;
  const keepMessages = options.keepMessages ?? 500;
  const keepDoneTasks = options.keepDoneTasks ?? 200;
  const min = options.minToCompact ?? 1000;

  return {
    events: compactNdjson(repoPath, "events", "events.ndjson", keepEvents, min),
    messages: compactNdjson(repoPath, "messages", "messages.ndjson", keepMessages, min),
    tasks: compactTasks(repoPath, keepDoneTasks, min),
  };
}
