import fs from "fs";
import path from "path";

const FORMAT_VERSION = 1;
const MEMORY_FILENAME = "AGENTS.md";
const SESSION_HEADER_RE = /^## Session: (\d{4}-\d{2}-\d{2})$/;
const AGENT_HEADER_RE = /^### ([^-][^\n]*?) — ([^\n]+)$/;
const MESSAGE_RE = /^\*\*([^*]+)\*\* — (.+)$/;

type MemoryEntry = {
  sessionDate: string;
  agent: string;
  persona: string;
  speaker: string;
  message: string;
};

type SessionResult = {
  status: "created" | "exists";
  session: string;
};

type AppendResult = {
  status: "appended";
  speaker: string;
  agent: string;
  persona: string;
};

function getMemoryPath(repoPath: string): string {
  return path.join(repoPath, MEMORY_FILENAME);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertRepoPath(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new Error("repo_path must be an absolute path");
  }
}

function buildHeader(repoPath: string): string {
  return [
    "---",
    `format: ${FORMAT_VERSION}`,
    `project: ${path.basename(repoPath)}`,
    `created: ${today()}`,
    "---",
    "",
    "# Agent Memory",
    "",
  ].join("\n");
}

function ensureFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buildHeader(path.dirname(filePath)), "utf8");
  }
}

function extractFormatVersion(content: string): number | null {
  const match = content.match(/^---\nformat: (\d+)\n/m);
  return match ? Number(match[1]) : null;
}

function readFile(filePath: string): string {
  ensureFile(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const formatVersion = extractFormatVersion(content);

  if (formatVersion !== null && formatVersion > FORMAT_VERSION) {
    throw new Error(
      `AGENTS.md uses format ${formatVersion}, but this server only supports ${FORMAT_VERSION}`
    );
  }

  return content;
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

function normalizeMessage(message: unknown): string {
  const normalized = String(message ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  if (!normalized) {
    throw new Error("message cannot be empty");
  }

  return normalized;
}

function appendText(filePath: string, text: string): void {
  fs.appendFileSync(filePath, text, "utf8");
}

function parseEntries(content: string): MemoryEntry[] {
  const lines = content.split("\n");
  const entries: MemoryEntry[] = [];
  let sessionDate: string | null = null;
  let agent: string | null = null;
  let persona: string | null = null;

  for (const line of lines) {
    const sessionMatch = line.match(SESSION_HEADER_RE);
    if (sessionMatch) {
      sessionDate = sessionMatch[1];
      agent = null;
      persona = null;
      continue;
    }

    const agentMatch = line.match(AGENT_HEADER_RE);
    if (agentMatch) {
      agent = agentMatch[1].trim();
      persona = agentMatch[2].trim();
      continue;
    }

    const messageMatch = line.match(MESSAGE_RE);
    if (messageMatch && sessionDate && agent && persona) {
      entries.push({
        sessionDate,
        agent,
        persona,
        speaker: messageMatch[1].trim(),
        message: messageMatch[2].trim(),
      });
    }
  }

  return entries;
}

function ensureSessionAndSection(content: string, agent: string, persona: string): string {
  const activeDate = today();
  const sessionHeader = `## Session: ${activeDate}`;
  const agentHeader = `### ${agent} — ${persona}`;
  let addition = "";

  const trimmed = content.trimEnd();
  if (!trimmed.includes(sessionHeader)) {
    addition += `\n## Session: ${activeDate}\n\n`;
  } else if (!trimmed.endsWith(agentHeader)) {
    addition += "\n";
  }

  if (!trimmed.endsWith(agentHeader)) {
    addition += `${agentHeader}\n`;
  }

  return addition;
}

export function startSession(repoPath: string, agent: string, persona: string): SessionResult {
  assertRepoPath(repoPath);
  const normalizedAgent = normalizeLabel(agent, "agent");
  const normalizedPersona = normalizeLabel(persona, "persona");
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const addition = ensureSessionAndSection(content, normalizedAgent, normalizedPersona);

  if (!addition) {
    return { status: "exists", session: `${today()} — ${normalizedAgent}/${normalizedPersona}` };
  }

  appendText(filePath, addition);
  return { status: "created", session: `${today()} — ${normalizedAgent}/${normalizedPersona}` };
}

export function appendMessage(
  repoPath: string,
  agent: string,
  persona: string,
  speaker: string,
  message: string
): AppendResult {
  assertRepoPath(repoPath);
  const normalizedAgent = normalizeLabel(agent, "agent");
  const normalizedPersona = normalizeLabel(persona, "persona");
  const normalizedSpeaker = normalizeLabel(speaker, "speaker");
  const normalizedMessage = normalizeMessage(message);
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const addition = ensureSessionAndSection(content, normalizedAgent, normalizedPersona);

  if (addition) {
    appendText(filePath, addition);
  }

  appendText(filePath, `**${normalizedSpeaker}** — ${normalizedMessage}\n`);
  return {
    status: "appended",
    speaker: normalizedSpeaker,
    agent: normalizedAgent,
    persona: normalizedPersona,
  };
}

export function readMemory(
  repoPath: string,
  filterAgent?: string,
  filterPersona?: string
): string {
  assertRepoPath(repoPath);
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);

  if (!filterAgent && !filterPersona) {
    return content;
  }

  const entries = parseEntries(content).filter((entry) => {
    if (filterAgent && entry.agent !== filterAgent) {
      return false;
    }
    if (filterPersona && entry.persona !== filterPersona) {
      return false;
    }
    return true;
  });

  return entries
    .map(
      (entry) =>
        `[${entry.sessionDate}] ${entry.agent}/${entry.persona} ${entry.speaker}: ${entry.message}`
    )
    .join("\n");
}

export function getContext(repoPath: string, lastN = 20): string {
  assertRepoPath(repoPath);
  if (!Number.isInteger(lastN) || lastN <= 0) {
    throw new Error("last_n must be a positive integer");
  }

  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const entries = parseEntries(content).slice(-lastN);

  return entries
    .map(
      (entry) =>
        `[${entry.sessionDate}] ${entry.agent}/${entry.persona} ${entry.speaker}: ${entry.message}`
    )
    .join("\n");
}
