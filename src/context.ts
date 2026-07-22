import { activeClaims } from "./claims.ts";
import { getEvents } from "./events.ts";
import { listTasks } from "./tasks.ts";
import { listWritedowns } from "./writedown.ts";

// ── unified cold-start context ────────────────────────────────────────────────
// One call that answers "where are we?" for an agent joining the checkout:
// the latest session writedown (long-term memory), the live task board and
// file claims (who is doing what right now), and recent events. This replaces
// the legacy line-log get_context and is what CLAUDE.md/GEMINI.md tell agents
// to call before touching anything.

export function getContext(repoPath: string, lastEvents = 15): string {
  const sections: string[] = [];

  const writedowns = listWritedowns(repoPath);
  const latest = writedowns.at(-1);
  if (latest) {
    sections.push(
      `## Latest writedown — ${latest.created} (${latest.agent}/${latest.persona})`,
      "",
      latest.body.trim(),
      ""
    );
  } else {
    sections.push("## Latest writedown", "", "_None yet. Run /writedown to capture a session._", "");
  }

  const tasks = listTasks(repoPath);
  const open = tasks.filter((t) => t.status === "pending" || t.status === "claimed");
  sections.push("## Task board");
  if (tasks.length === 0) {
    sections.push("", "_Empty. Use plan_tasks to decompose work before parallelizing._", "");
  } else {
    sections.push("", `${open.length} open / ${tasks.length} total`, "");
    for (const task of open) {
      const who = task.agent ? ` (claimed by ${task.agent})` : "";
      const files = task.files.length > 0 ? ` — files: ${task.files.join(", ")}` : "";
      sections.push(`- [${task.status}] ${task.id}: ${task.title}${who}${files}`);
    }
    sections.push("");
  }

  const claims = activeClaims(repoPath);
  sections.push("## Active file claims");
  if (claims.length === 0) {
    sections.push("", "_None. All files are free to claim._", "");
  } else {
    sections.push("");
    for (const claim of claims) {
      sections.push(
        `- ${claim.agent} holds ${claim.paths.join(", ")} — ${claim.reason} (expires ${claim.expires})`
      );
    }
    sections.push("");
  }

  const { events, cursor } = getEvents(repoPath, 0, Number.MAX_SAFE_INTEGER);
  const recent = events.slice(-lastEvents);
  sections.push(`## Recent events (cursor: ${cursor})`);
  if (recent.length === 0) {
    sections.push("", "_No events yet._");
  } else {
    sections.push("");
    for (const event of recent) {
      sections.push(`- [${event.seq}] ${event.time} ${event.agent} ${event.type}: ${event.message}`);
    }
  }

  return sections.join("\n");
}
