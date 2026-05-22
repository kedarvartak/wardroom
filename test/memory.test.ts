import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";

import {
  appendMessage,
  getContext,
  readMemory,
  startSession,
} from "../src/memory.ts";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-memo-"));
}

test("startSession creates AGENTS.md with a dated section", () => {
  const repoPath = makeRepo();
  const result = startSession(repoPath, "codex", "coder");
  const content = fs.readFileSync(path.join(repoPath, "AGENTS.md"), "utf8");

  assert.equal(result.status, "created");
  assert.match(content, /^---\nformat: 1\nproject: multi-agent-memo-/m);
  assert.match(content, /## Session: \d{4}-\d{2}-\d{2}/);
  assert.match(content, /### codex — coder/);
});

test("appendMessage creates the section if the caller skipped startSession", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "claude", "architect", "claude", "Scaffolded auth.");

  const content = fs.readFileSync(path.join(repoPath, "AGENTS.md"), "utf8");
  assert.match(content, /## Session: \d{4}-\d{2}-\d{2}/);
  assert.match(content, /### claude — architect/);
  assert.match(content, /\*\*claude\*\* — Scaffolded auth\./);
});

test("readMemory supports agent and persona filtering", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "codex", "coder", "codex", "Built endpoint.");
  appendMessage(repoPath, "gemini", "reviewer", "gemini", "Found a bug.");

  const byAgent = readMemory(repoPath, "codex");
  const byPersona = readMemory(repoPath, undefined, "reviewer");

  assert.match(byAgent, /codex\/coder codex: Built endpoint\./);
  assert.doesNotMatch(byAgent, /gemini/);
  assert.match(byPersona, /gemini\/reviewer gemini: Found a bug\./);
  assert.doesNotMatch(byPersona, /Built endpoint/);
});

test("getContext returns the last N compact entries", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "codex", "coder", "me", "First");
  appendMessage(repoPath, "codex", "coder", "codex", "Second");
  appendMessage(repoPath, "codex", "coder", "me", "Third");

  const context = getContext(repoPath, 2);
  assert.doesNotMatch(context, /First/);
  assert.match(context, /Second/);
  assert.match(context, /Third/);
});
