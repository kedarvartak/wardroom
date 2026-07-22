import path from "path";
import { activeClaims } from "./claims.ts";
import { getEvents } from "./events.ts";
import { crosstalk, openQuestions, unreadCount } from "./messages.ts";
import type { PoolState } from "./pool.ts";
import { listTasks, type TaskStatus } from "./tasks.ts";

// ── terminal dashboard ────────────────────────────────────────────────────────
// Pure state -> string. `wardroom watch` calls this in a loop; `wardroom
// board`/`log` reuse pieces. No TUI framework: plain lines with a little ANSI,
// so it stays scrollback-friendly, ssh-safe, and trivially testable.

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "o",
  claimed: "*",
  review: "@",
  done: "x",
  failed: "!",
};

function header(text: string, width: number): string {
  const label = ` ${text} `;
  const fill = Math.max(4, width - label.length - 2);
  return `${DIM}--${RESET}${BOLD}${label}${RESET}${DIM}${"-".repeat(fill)}${RESET}`;
}

function shortTime(iso: string): string {
  return iso.slice(11, 19) || iso;
}

export function renderDashboard(repoPath: string, width = 78): string {
  const lines: string[] = [];
  const now = new Date().toISOString().slice(11, 19);
  lines.push(`${BOLD}WARDROOM${RESET}  ${path.basename(repoPath)}  ${DIM}${now} UTC${RESET}`);
  lines.push("");

  // board
  const tasks = listTasks(repoPath);
  lines.push(header("board", width));
  if (tasks.length === 0) {
    lines.push(`${DIM}  empty - plan_tasks to add work${RESET}`);
  } else {
    for (const task of tasks) {
      const who = task.agent ? ` ${CYAN}@${task.agent}${RESET}` : "";
      const deps = task.dependsOn.length > 0 ? ` ${DIM}(after ${task.dependsOn.join(", ")})${RESET}` : "";
      const files = task.files.length > 0 ? ` ${DIM}[${task.files.join(", ")}]${RESET}` : "";
      lines.push(`  ${STATUS_ICON[task.status]} ${task.id}${who}  ${task.title}${deps}${files}`);
    }
  }
  lines.push("");

  // claims
  const claims = activeClaims(repoPath);
  lines.push(header("claims", width));
  if (claims.length === 0) {
    lines.push(`${DIM}  none - all files free${RESET}`);
  } else {
    for (const claim of claims) {
      lines.push(
        `  ${CYAN}${claim.agent}${RESET} holds ${claim.paths.join(", ")}  ${DIM}${claim.reason} (until ${shortTime(claim.expires)})${RESET}`
      );
    }
  }
  lines.push("");

  // crosstalk
  const talk = crosstalk(repoPath, 12);
  lines.push(header("crosstalk", width));
  if (talk.length === 0) {
    lines.push(`${DIM}  quiet - agents message via send_message${RESET}`);
  } else {
    for (const m of talk) {
      const kindTag = m.kind === "info" ? "" : ` ${YELLOW}[${m.kind}]${RESET}`;
      const toCaptain = m.to === "captain" ? YELLOW : "";
      lines.push(
        `  ${DIM}${shortTime(m.time)}${RESET} ${CYAN}${m.from}${RESET} -> ${toCaptain}${m.to}${RESET}${kindTag} ${m.body}  ${DIM}(t${m.thread})${RESET}`
      );
    }
  }
  const open = openQuestions(repoPath);
  for (const q of open) {
    lines.push(`  ${YELLOW}? unanswered: ${q.from} -> ${q.to} (t${q.thread}) ${q.body}${RESET}`);
  }
  lines.push("");

  // events
  const { events } = getEvents(repoPath, 0, Number.MAX_SAFE_INTEGER);
  const recent = events.slice(-8);
  lines.push(header("events", width));
  if (recent.length === 0) {
    lines.push(`${DIM}  no events yet${RESET}`);
  } else {
    for (const e of recent) {
      lines.push(`  ${DIM}${shortTime(e.time)} [${e.seq}]${RESET} ${CYAN}${e.agent}${RESET} ${e.type}: ${e.message}`);
    }
  }
  lines.push("");

  // status
  const openTasks = tasks.filter((t) => t.status === "pending" || t.status === "claimed").length;
  const captainUnread = unreadCount(repoPath, "captain");
  const captainNote = captainUnread > 0 ? `${YELLOW}${captainUnread} message(s) for you${RESET}` : "no messages for you";
  lines.push(header("status", width));
  lines.push(
    `  ${openTasks} open task(s) | ${claims.length} active claim(s) | ${captainNote} | ${DIM}reply: wardroom say --to <agent> "..."${RESET}`
  );

  return lines.join("\n");
}

function elapsed(sinceMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const PHASE_LABEL: Record<string, string> = {
  idle: "idle",
  waiting: "waiting",
  claimed: "claimed",
  working: "working",
  verifying: "verifying",
  done: "done",
  failed: "failed",
};

// The live multiplexed view for `wardroom run` with a pool: a board strip, one
// pane per agent (its current task + recent activity), the shared crosstalk
// feed, and a status line. Per-agent panes come from in-memory PoolState (the
// agents' transient stdout is not persisted); board and crosstalk come from
// the .memo files every worker writes to.
export function renderPool(repoPath: string, state: PoolState, width = 88): string {
  const lines: string[] = [];
  lines.push(
    `${BOLD}WARDROOM${RESET}  ${path.basename(repoPath)}  ${DIM}${state.panes.length} agents  elapsed ${elapsed(state.startedAt)}${RESET}`
  );
  lines.push("");

  const tasks = listTasks(repoPath);
  const done = tasks.filter((t) => t.status === "done").length;
  lines.push(header(`board  ${done}/${tasks.length} done`, width));
  if (tasks.length > 0) {
    lines.push("  " + tasks.map((t) => `${STATUS_ICON[t.status]}${t.id.replace("task-", "")}`).join("  "));
  }
  lines.push("");

  for (const pane of state.panes) {
    const task = pane.taskId ? `${pane.taskId}: ${pane.taskTitle ?? ""}`.trim() : "";
    const head = `${pane.agent}  ${DIM}${PHASE_LABEL[pane.phase] ?? pane.phase}${task ? ` ${task}` : ""}${RESET}`;
    lines.push(header(head, width));
    if (pane.lines.length === 0) {
      lines.push(`  ${DIM}...${RESET}`);
    } else {
      for (const line of pane.lines) {
        lines.push(`  ${line.length > width - 4 ? line.slice(0, width - 5) + "…" : line}`);
      }
    }
    const meta = `${pane.completed} done, ${pane.failed} failed${pane.tokens ? `, ${pane.tokens} tok` : ""}`;
    lines.push(`  ${DIM}${meta}${RESET}`);
  }
  lines.push("");

  const talk = crosstalk(repoPath, 6);
  lines.push(header("crosstalk", width));
  if (talk.length === 0) {
    lines.push(`${DIM}  quiet${RESET}`);
  } else {
    for (const m of talk) {
      const kindTag = m.kind === "info" ? "" : ` ${YELLOW}[${m.kind}]${RESET}`;
      const toCaptain = m.to === "captain" ? YELLOW : "";
      lines.push(
        `  ${DIM}${shortTime(m.time)}${RESET} ${CYAN}${m.from}${RESET} -> ${toCaptain}${m.to}${RESET}${kindTag} ${m.body}  ${DIM}(t${m.thread})${RESET}`
      );
    }
  }
  lines.push("");

  const captainUnread = unreadCount(repoPath, "captain");
  const working = state.panes.filter((p) => p.phase === "working" || p.phase === "verifying").length;
  const captainNote =
    captainUnread > 0
      ? `${YELLOW}${captainUnread} question(s) for you — reply: wardroom say --to <agent> "..." --thread <n>${RESET}`
      : "no questions for you";
  lines.push(header("status", width));
  lines.push(`  ${working} working | ${done}/${tasks.length} done | ${captainNote}`);

  return lines.join("\n");
}

// Plain merged timeline of events + messages, oldest first. Used by
// `wardroom log`; colorless so it pipes cleanly.
export function renderLog(repoPath: string, lastN = 50): string {
  const { events } = getEvents(repoPath, 0, Number.MAX_SAFE_INTEGER);
  const talk = crosstalk(repoPath, Number.MAX_SAFE_INTEGER);

  const rows = [
    ...events.map((e) => ({ time: e.time, line: `${e.time} event ${e.agent} ${e.type}: ${e.message}` })),
    ...talk.map((m) => ({
      time: m.time,
      line: `${m.time} [${m.from}->${m.to}] ${m.kind === "info" ? "" : `(${m.kind}) `}${m.body}`,
    })),
  ]
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(-lastN);

  return rows.map((r) => r.line).join("\n") || "(log is empty)";
}
