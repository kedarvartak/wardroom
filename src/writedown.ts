import fs from "fs";
import path from "path";

// ── writedown storage ──────────────────────────────────────────────────────────
// A "writedown" is a structured, user-triggered snapshot of a working session.
// Unlike the append-only message log, each writedown is its own file under
// `.memo/sessions/`. Because every writedown is a NEW file, concurrent writes
// from different agents never touch the same path — no locks, no append races.
//
// `AGENTS.md` is treated as a DERIVED view: it is regenerated from the sessions
// directory on every write. It is the small, cold-start file an agent reads
// first ("Latest State" + an index of past sessions). The per-session files are
// the source of truth.

const SESSIONS_DIR = path.join(".memo", "sessions");
const INDEX_FILENAME = "AGENTS.md";
const INDEX_FORMAT_VERSION = 2;

type WriteSessionResult = {
  status: "written";
  sessionId: string;
  file: string;
  indexedSessions: number;
};

type SessionMeta = {
  sessionId: string;
  agent: string;
  persona: string;
  created: string;
  summary: string;
  body: string;
  file: string;
};

function assertRepoPath(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new Error("repo_path must be an absolute path");
  }
}

function normalizeLabel(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  if (normalized.includes("\n")) {
    throw new Error(`${fieldName} must be single-line text`);
  }
  return normalized;
}

// Filesystem-safe slug for an agent name used in the session filename.
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Local-time stamp, colon-free so it is a valid filename and sorts
// lexicographically == chronologically. e.g. 2026-05-31T143005
function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Human-readable timestamp for the frontmatter `created` field.
function humanStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// Collapse a content blob to a single-line summary fallback: first heading text
// or first non-empty line, trimmed to a reasonable length.
function deriveSummary(content: string): string {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "");
    if (heading) {
      return heading.length > 120 ? `${heading.slice(0, 117)}…` : heading;
    }
  }
  return "(no summary)";
}

function sessionsDirPath(repoPath: string): string {
  return path.join(repoPath, SESSIONS_DIR);
}

// Reserve a unique filename even if two writedowns land in the same second.
function uniqueSessionPath(dir: string, baseId: string): { id: string; file: string } {
  let id = baseId;
  let file = path.join(dir, `${id}.md`);
  let counter = 2;
  while (fs.existsSync(file)) {
    id = `${baseId}-${counter}`;
    file = path.join(dir, `${id}.md`);
    counter += 1;
  }
  return { id, file };
}

function buildSessionFile(meta: Omit<SessionMeta, "file">): string {
  return [
    "---",
    `session: ${meta.sessionId}`,
    `agent: ${meta.agent}`,
    `persona: ${meta.persona}`,
    `created: ${meta.created}`,
    `summary: ${meta.summary.replace(/\n/g, " ")}`,
    "---",
    "",
    meta.body.trim(),
    "",
  ].join("\n");
}

function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { fields: {}, body: content };
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const fieldMatch = line.match(/^([a-zA-Z_]+):\s?(.*)$/);
    if (fieldMatch) {
      fields[fieldMatch[1]] = fieldMatch[2].trim();
    }
  }
  return { fields, body: match[2].trim() };
}

function listSessionMeta(repoPath: string): SessionMeta[] {
  const dir = sessionsDirPath(repoPath);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort() // lexicographic == chronological
    .map((name) => {
      const file = path.join(dir, name);
      const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
      const sessionId = fields.session ?? name.replace(/\.md$/, "");
      return {
        sessionId,
        agent: fields.agent ?? "unknown",
        persona: fields.persona ?? "unknown",
        created: fields.created ?? sessionId,
        summary: fields.summary || deriveSummary(body),
        body,
        file,
      };
    });
}

// Read the `created:` date already recorded in AGENTS.md so a rebuild preserves
// the original project start date instead of resetting it.
function existingProjectCreated(indexPath: string): string | null {
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  const match = fs.readFileSync(indexPath, "utf8").match(/^created:\s?(.+)$/m);
  return match ? match[1].trim() : null;
}

function sessionLink(sessionId: string): string {
  return `${SESSIONS_DIR.split(path.sep).join("/")}/${sessionId}.md`;
}

// Regenerate AGENTS.md from the sessions directory. Idempotent: the file is a
// pure function of the per-session writedowns on disk.
function rebuildIndex(repoPath: string): number {
  const sessions = listSessionMeta(repoPath);
  const indexPath = path.join(repoPath, INDEX_FILENAME);
  const created = existingProjectCreated(indexPath) ?? stamp().slice(0, 10);
  const latest = sessions.at(-1);

  const lines: string[] = [
    "---",
    `format: ${INDEX_FORMAT_VERSION}`,
    `project: ${path.basename(repoPath)}`,
    `created: ${created}`,
    `updated: ${latest ? latest.created : created}`,
    "---",
    "",
    "# Agent Memory",
    "",
    "> Cold-start file. Read **Latest State** first — it is the most recent session" +
      " writedown. Full per-session writedowns live in `.memo/sessions/`. This file" +
      " is generated; edit the session files, not this index.",
    "",
    "## Latest State",
    "",
  ];

  if (latest) {
    lines.push(
      `_${latest.created} — ${latest.agent}/${latest.persona} —` +
        ` [full writedown](${sessionLink(latest.sessionId)})_`,
      "",
      latest.body.trim(),
      ""
    );
  } else {
    lines.push("_No writedowns yet. Run `/writedown` to capture this session._", "");
  }

  lines.push("## Sessions", "");
  if (sessions.length === 0) {
    lines.push("_None yet._", "");
  } else {
    for (const meta of [...sessions].reverse()) {
      lines.push(
        `- [${meta.created}](${sessionLink(meta.sessionId)}) —` +
          ` ${meta.agent}/${meta.persona} — ${meta.summary}`
      );
    }
    lines.push("");
  }

  fs.writeFileSync(indexPath, lines.join("\n"), "utf8");
  return sessions.length;
}

export function writeSession(
  repoPath: string,
  agent: string,
  persona: string,
  content: string,
  summary?: string
): WriteSessionResult {
  assertRepoPath(repoPath);
  const normalizedAgent = normalizeLabel(agent, "agent");
  const normalizedPersona = normalizeLabel(persona, "persona");
  const body = String(content ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) {
    throw new Error("content cannot be empty");
  }
  const resolvedSummary = (summary && summary.trim()) || deriveSummary(body);

  const dir = sessionsDirPath(repoPath);
  fs.mkdirSync(dir, { recursive: true });

  const baseId = `${stamp()}-${slug(normalizedAgent) || "agent"}`;
  const { id, file } = uniqueSessionPath(dir, baseId);

  fs.writeFileSync(
    file,
    buildSessionFile({
      sessionId: id,
      agent: normalizedAgent,
      persona: normalizedPersona,
      created: humanStamp(),
      summary: resolvedSummary,
      body,
    }),
    "utf8"
  );

  const indexedSessions = rebuildIndex(repoPath);

  return {
    status: "written",
    sessionId: id,
    file: path.relative(repoPath, file),
    indexedSessions,
  };
}

// Manual recall: return the latest N writedowns in full (newest first) plus a
// compact index of everything on file. This is the counterpart to write_session
// — an agent calls it on demand to load context into a fresh chat, rather than
// relying on the cold-start hook.
export function readMemo(repoPath: string, lastN = 1): string {
  assertRepoPath(repoPath);
  if (!Number.isInteger(lastN) || lastN <= 0) {
    throw new Error("last_n must be a positive integer");
  }

  const sessions = listSessionMeta(repoPath);
  if (sessions.length === 0) {
    return "No writedowns yet. Run `/writedown` to capture the current session.";
  }

  const recent = sessions.slice(-lastN).reverse();
  const blocks = recent.map((meta) =>
    [
      `## ${meta.created} — ${meta.agent}/${meta.persona}`,
      `_session: ${meta.sessionId} · ${meta.summary}_`,
      "",
      meta.body.trim(),
    ].join("\n")
  );

  const indexLines = [...sessions]
    .reverse()
    .map(
      (meta) =>
        `- ${meta.created} — ${meta.agent}/${meta.persona} — ${meta.summary}` +
        ` (${sessionLink(meta.sessionId)})`
    );

  return [
    `# Memo recall — ${recent.length} of ${sessions.length} writedown(s)`,
    "",
    blocks.join("\n\n---\n\n"),
    "",
    "## All sessions on file",
    "",
    indexLines.join("\n"),
  ].join("\n");
}

// Exposed for tooling/tests that want the parsed session list or a forced rebuild.
export function listWritedowns(repoPath: string): SessionMeta[] {
  assertRepoPath(repoPath);
  return listSessionMeta(repoPath);
}

export function rebuildWritedownIndex(repoPath: string): number {
  assertRepoPath(repoPath);
  return rebuildIndex(repoPath);
}
