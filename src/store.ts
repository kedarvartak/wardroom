import fs from "fs";
import path from "path";

// ── coordination storage foundation ───────────────────────────────────────────
// Every piece of coordination state lives under `<repo>/.memo/`. Multiple MCP
// server processes (one per CLI agent) mutate this state concurrently, so every
// mutation goes through:
//
//   1. an advisory lock — a lock *directory* created with mkdir(), which is
//      atomic on every platform Node supports (either you created it or you
//      didn't; no TOCTOU window),
//   2. an atomic write — temp file + rename(), so readers never observe a
//      half-written JSON file.
//
// Locks go stale after LOCK_STALE_MS (a crashed agent must not deadlock the
// repo) and acquisition times out rather than hanging a tool call forever.

const MEMO_DIR = ".memo";
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 8_000;

export function assertRepoPath(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new Error("repo_path must be an absolute path");
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    // Containment: refuse to invent directories from a typo'd or hostile path.
    throw new Error(`repo_path does not exist or is not a directory: ${repoPath}`);
  }
}

export function memoDir(repoPath: string): string {
  assertRepoPath(repoPath);
  const dir = path.join(repoPath, MEMO_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Synchronous sleep without spinning the CPU. Atomics.wait blocks the thread
// for the timeout when the expected value matches — effectively sleep(ms).
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock<T>(repoPath: string, name: string, fn: () => T): T {
  const lockDir = path.join(memoDir(repoPath), `${name}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch {
      // Held by someone else. Break stale locks left by crashed processes.
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock vanished between mkdir failing and stat — retry immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out acquiring ${name} lock — another agent may have crashed mid-write; retry shortly`
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function normalizeLabel(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  if (normalized.includes("\n")) {
    throw new Error(`${fieldName} must be single-line text`);
  }
  return normalized;
}

// Agents are a small known set; case-fold so `Claude` and `claude` are one
// identity instead of two phantom ones that filters silently miss.
export function normalizeAgent(value: unknown): string {
  return normalizeLabel(value, "agent").toLowerCase();
}
