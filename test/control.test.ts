import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveConfig, vendorFor, type WardroomConfig } from "../src/config.ts";
import { startSession } from "../src/session.ts";
import { planTasks } from "../src/tasks.ts";
import { parseSlash } from "../src/tui/commands.ts";

function makeGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-ctl-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

const AGENT = `
import fs from "fs";
const me = process.argv[2];
const id = ((process.argv[3] ?? "").match(/task-(\\d+)/) ?? [])[1] ?? "?";
fs.appendFileSync("owners.txt", me + ":" + id + "\\n");
console.log(me + " did " + id);
`;

function fakeConfig(repo: string, agents: string[]): WardroomConfig {
  const file = path.join(repo, "fake.mjs");
  fs.writeFileSync(file, AGENT);
  const config: WardroomConfig = { agents: {}, taskTimeoutMinutes: 5, review: "off", planner: agents[0] };
  for (const a of agents) config.agents[a] = { adapter: "gemini", bin: process.execPath, args: [file, a] };
  return config;
}

// ── slash parser ──────────────────────────────────────────────────────────────

test("parseSlash: every command form and the error paths", () => {
  assert.equal(parseSlash("hello there"), null);
  assert.deepEqual(parseSlash("/help"), { kind: "help" });
  assert.deepEqual(parseSlash("/quit"), { kind: "quit" });
  assert.deepEqual(parseSlash("/crew"), { kind: "crew" });
  assert.deepEqual(parseSlash("/add claude-2"), { kind: "add", name: "claude-2", vendor: undefined });
  assert.deepEqual(parseSlash("/add fixer codex"), { kind: "add", name: "fixer", vendor: "codex" });
  assert.deepEqual(parseSlash("/drop Codex"), { kind: "drop", name: "codex" });
  assert.deepEqual(parseSlash("/conductor claude"), { kind: "conductor", name: "claude" });
  assert.deepEqual(parseSlash("/review all"), { kind: "review", policy: "all" });
  assert.deepEqual(parseSlash("/say ship it"), { kind: "say", body: "ship it" });
  assert.equal(parseSlash("/add")?.kind, "error");
  assert.equal(parseSlash("/say")?.kind, "error");
  assert.equal(parseSlash("/frobnicate")?.kind, "error");
});

test("vendorFor infers the family from instance names", () => {
  assert.equal(vendorFor("claude"), "claude");
  assert.equal(vendorFor("claude-2"), "claude");
  assert.equal(vendorFor("codex_b"), "codex");
  assert.equal(vendorFor("fixer"), undefined);
});

// ── config persistence ────────────────────────────────────────────────────────

test("saveConfig persists control changes and preserves unknown fields", () => {
  const repo = makeGitRepo();
  fs.writeFileSync(
    path.join(repo, "wardroom.json"),
    JSON.stringify({ agents: { claude: {} }, review: "off", planner: "claude", futureField: { keep: true } })
  );
  const config = fakeConfig(repo, ["claude"]);
  config.review = "all";
  saveConfig(repo, config);

  const onDisk = JSON.parse(fs.readFileSync(path.join(repo, "wardroom.json"), "utf8"));
  assert.equal(onDisk.review, "all");
  assert.deepEqual(onDisk.futureField, { keep: true });
  assert.ok(onDisk.agents.claude.bin);
});

// ── live crew control ─────────────────────────────────────────────────────────

test("an agent added mid-session goes live and runs delegated work; changes persist", async () => {
  const repo = makeGitRepo();
  const config = fakeConfig(repo, ["claude", "helper"]);
  // Start with only claude on the crew; "helper" exists in config but is not running.
  const session = startSession(repo, ["claude"], config, {});
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(session.crew(), ["claude"]);
  const added = session.addAgent("helper");
  assert.ok(added.ok, added.ok ? "" : added.error);
  assert.deepEqual(session.crew().sort(), ["claude", "helper"]);

  // Work directed at the newcomer gets done by it.
  planTasks(repo, "conductor", [{ title: "for the newcomer", files: ["src/x.ts"], assignee: "helper" }]);
  await new Promise((r) => setTimeout(r, 3000));
  await session.stop();
  assert.match(fs.readFileSync(path.join(repo, "owners.txt"), "utf8"), /helper:1/);

  // The hire survived to wardroom.json.
  const onDisk = JSON.parse(fs.readFileSync(path.join(repo, "wardroom.json"), "utf8"));
  assert.ok(onDisk.agents.helper);
});

test("dropping an agent shrinks the live crew; the last member cannot be dropped", async () => {
  const repo = makeGitRepo();
  const config = fakeConfig(repo, ["claude", "codex"]);
  const session = startSession(repo, ["claude", "codex"], config, {});
  await new Promise((r) => setTimeout(r, 300));

  const dropped = session.removeAgent("codex");
  assert.ok(dropped.ok);
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(session.crew(), ["claude"]);

  const last = session.removeAgent("claude");
  assert.ok(!last.ok && /last crew member/.test(last.ok ? "" : last.error));
  await session.stop();
});

test("setConductor and setReview validate and persist; addAgent rejects unknown vendors", async () => {
  const repo = makeGitRepo();
  const config = fakeConfig(repo, ["claude", "codex"]);
  const session = startSession(repo, ["claude"], config, {});
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!session.setConductor("gemini").ok);
  assert.ok(session.setConductor("codex").ok);
  assert.ok(!session.setReview("sometimes").ok);
  assert.ok(session.setReview("changed-files").ok);
  const bad = session.addAgent("fixer");
  assert.ok(!bad.ok && /unknown vendor/.test(bad.ok ? "" : bad.error));

  const onDisk = JSON.parse(fs.readFileSync(path.join(repo, "wardroom.json"), "utf8"));
  assert.equal(onDisk.conductor, "codex");
  assert.equal(onDisk.review, "changed-files");
  await session.stop();
});
