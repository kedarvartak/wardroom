import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";

import { listWritedowns, readMemo, writeSession } from "../src/writedown.ts";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-memo-wd-"));
}

test("writeSession creates a per-session file and a derived AGENTS.md", () => {
  const repoPath = makeRepo();
  const result = writeSession(
    repoPath,
    "claude",
    "architect",
    "## Summary\nScaffolded auth.\n## Decisions\n- Use Redis #decision",
    "Scaffolded auth"
  );

  assert.equal(result.status, "written");
  assert.equal(result.indexedSessions, 1);
  assert.ok(fs.existsSync(path.join(repoPath, result.file)));

  const index = fs.readFileSync(path.join(repoPath, "AGENTS.md"), "utf8");
  assert.match(index, /^format: 2$/m);
  assert.match(index, /## Latest State/);
  assert.match(index, /Scaffolded auth\./);
  assert.match(index, /Use Redis #decision/);
});

test("each writedown is its own file — no shared-file mutation", () => {
  const repoPath = makeRepo();
  writeSession(repoPath, "claude", "architect", "First session body", "first");
  writeSession(repoPath, "codex", "coder", "Second session body", "second");

  const files = fs.readdirSync(path.join(repoPath, ".memo", "sessions"));
  assert.equal(files.length, 2);
});

test("multi-line content with markdown is preserved verbatim", () => {
  const repoPath = makeRepo();
  const body = "## Summary\nLine one.\n\n```ts\nconst x = 1;\n```\n- bullet **bold**";
  const result = writeSession(repoPath, "claude", "coder", body);

  const stored = fs.readFileSync(path.join(repoPath, result.file), "utf8");
  assert.match(stored, /```ts\nconst x = 1;\n```/);
  assert.match(stored, /- bullet \*\*bold\*\*/);
});

test("summary falls back to the first heading when not provided", () => {
  const repoPath = makeRepo();
  writeSession(repoPath, "gemini", "reviewer", "## Reviewed the diff\nLooks good.");

  const [meta] = listWritedowns(repoPath);
  assert.equal(meta.summary, "Reviewed the diff");
});

test("readMemo returns the latest N writedowns and a full index", () => {
  const repoPath = makeRepo();
  writeSession(repoPath, "claude", "architect", "Oldest body", "oldest");
  writeSession(repoPath, "codex", "coder", "Middle body", "middle");
  writeSession(repoPath, "gemini", "reviewer", "Newest body", "newest");

  const recall = readMemo(repoPath, 2);
  assert.match(recall, /2 of 3 writedown\(s\)/);
  assert.match(recall, /Newest body/);
  assert.match(recall, /Middle body/);
  assert.doesNotMatch(recall, /Oldest body/);
  // index still lists every session
  assert.match(recall, /All sessions on file/);
  assert.match(recall, /oldest/);
});

test("readMemo on an empty repo is graceful", () => {
  const repoPath = makeRepo();
  assert.match(readMemo(repoPath), /No writedowns yet/);
});
