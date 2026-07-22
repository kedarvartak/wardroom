import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claimFiles } from "../src/claims.ts";
import { compact } from "../src/compact.ts";
import type { WardroomConfig } from "../src/config.ts";
import { editedPaths, evaluate } from "../src/guard.ts";
import { postEvent, getEvents } from "../src/events.ts";
import { getMessages, sendMessage } from "../src/messages.ts";
import { getPresence, heartbeat } from "../src/presence.ts";
import { runPool } from "../src/pool.ts";
import { listTasks, planTasks } from "../src/tasks.ts";

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-p5-"));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  return repo;
}

function fakeConfig(repo: string, agents: string[], script: string, extra: Partial<WardroomConfig> = {}): WardroomConfig {
  const file = path.join(repo, "fake-agent.mjs");
  fs.writeFileSync(file, script);
  const config: WardroomConfig = { agents: {}, taskTimeoutMinutes: 5, review: "off", planner: agents[0], ...extra };
  for (const a of agents) config.agents[a] = { adapter: "gemini", bin: process.execPath, args: [file, a] };
  return config;
}

// ── enforcement guard ─────────────────────────────────────────────────────────

test("editedPaths extracts targets per tool and ignores read-only tools", () => {
  assert.deepEqual(editedPaths("Edit", { file_path: "src/a.ts" }), ["src/a.ts"]);
  assert.deepEqual(editedPaths("Write", { file_path: "src/b.ts" }), ["src/b.ts"]);
  assert.deepEqual(editedPaths("NotebookEdit", { notebook_path: "n.ipynb" }), ["n.ipynb"]);
  assert.deepEqual(editedPaths("Bash", { command: "rm x" }), []);
  assert.deepEqual(editedPaths("Read", { file_path: "src/a.ts" }), []);
});

test("guard blocks edits to another agent's leased file, allows your own and free files", () => {
  const repo = makeRepo();
  claimFiles(repo, "codex", ["src/api/**"], "refactoring the api");

  const blocked = evaluate(repo, "claude", "Edit", { file_path: "src/api/routes.ts" });
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason ?? "", /codex holds a lease/);

  // The lease holder editing its own files is fine.
  assert.equal(evaluate(repo, "codex", "Edit", { file_path: "src/api/routes.ts" }).allow, true);
  // A file nobody leased is fine.
  assert.equal(evaluate(repo, "claude", "Edit", { file_path: "src/ui/App.tsx" }).allow, true);
  // Absolute paths are relativized to the repo.
  assert.equal(evaluate(repo, "claude", "Write", { file_path: path.join(repo, "src/api/db.ts") }).allow, false);
});

test("guard fails open on unknown tools and non-editing calls", () => {
  const repo = makeRepo();
  claimFiles(repo, "codex", ["**"], "everything");
  assert.equal(evaluate(repo, "claude", "Bash", { command: "ls" }).allow, true);
  assert.equal(evaluate(repo, "claude", "Read", { file_path: "src/a.ts" }).allow, true);
});

// ── compaction ────────────────────────────────────────────────────────────────

test("compaction archives old events/messages and keeps a working tail with seq intact", () => {
  const repo = makeRepo();
  for (let i = 0; i < 40; i++) postEvent(repo, "claude", "note", `event ${i}`);
  for (let i = 0; i < 40; i++) sendMessage(repo, "codex", "claude", `msg ${i}`);

  const result = compact(repo, { keepEvents: 10, keepMessages: 10, minToCompact: 20 });
  assert.equal(result.events.kept, 10);
  assert.equal(result.events.archived, 30);
  assert.equal(result.messages.kept, 10);

  // The tail still has the highest seq, so new appends continue the sequence.
  const next = postEvent(repo, "claude", "note", "after compaction");
  assert.equal(next.seq, 41);
  // Reads over the tail still work; an old cursor still filters correctly.
  assert.equal(getEvents(repo, 35).events.every((e) => e.seq > 35), true);
  // Archive files exist.
  assert.ok(fs.readdirSync(path.join(repo, ".memo", "archive")).some((f) => f.startsWith("events.ndjson")));
});

test("compaction archives terminal tasks but keeps active ones", () => {
  const repo = makeRepo();
  planTasks(
    repo,
    "captain",
    Array.from({ length: 12 }, (_, i) => ({ title: `t${i}` }))
  );
  // Mark 10 done directly in state, leave 2 pending.
  const file = path.join(repo, ".memo", "tasks.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  for (let i = 0; i < 10; i++) {
    state.tasks[i].status = "done";
    state.tasks[i].updated = new Date(Date.now() - (10 - i) * 1000).toISOString();
  }
  fs.writeFileSync(file, JSON.stringify(state));

  const r = compact(repo, { keepDoneTasks: 3, minToCompact: 5 });
  assert.equal(r.tasks.archived, 7); // 10 done - 3 kept
  assert.equal(listTasks(repo, "pending").length, 2); // active untouched
  assert.equal(listTasks(repo, "done").length, 3);
});

// ── presence ──────────────────────────────────────────────────────────────────

test("presence records who is active and goes stale", () => {
  const repo = makeRepo();
  heartbeat(repo, "claude", "working task-1");
  const p = getPresence(repo);
  assert.equal(p[0].agent, "claude");
  assert.equal(p[0].online, true);

  // Backdate to simulate staleness.
  const file = path.join(repo, ".memo", "presence.json");
  const map = JSON.parse(fs.readFileSync(file, "utf8"));
  map.claude.lastSeen = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(map));
  assert.equal(getPresence(repo)[0].online, false);
});

// ── token budget ──────────────────────────────────────────────────────────────

test("the pool stops claiming new tasks once the token budget is exceeded", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, files: [`src/${i}.ts`] })));

  // Each task's agent reports 100 tokens; a 150-token budget allows ~1-2 tasks
  // before new claims stop.
  const AGENT = `
const task = ((process.argv[3] ?? "").match(/task-(\\d+)/) ?? [])[1] ?? "0";
console.log("did task-" + task);
`;
  // gemini adapter has no usage events, so drive tokens via a claude-style
  // agent that prints a stream-json result with usage.
  const USAGE_AGENT = `
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", usage: { output_tokens: 100 } }));
`;
  const config: WardroomConfig = {
    agents: { claude: { adapter: "claude", bin: process.execPath, args: [] } },
    taskTimeoutMinutes: 5,
    review: "off",
    planner: "claude",
    budget: { tokens: 150 },
  };
  const scriptFile = path.join(repo, "usage-agent.mjs");
  fs.writeFileSync(scriptFile, USAGE_AGENT);
  config.agents.claude.args = [scriptFile];

  const result = await runPool(repo, ["claude"], config, {}, { writedown: false });
  assert.equal(result.budgetStopped, true);
  assert.ok(result.tokens >= 150, `tokens ${result.tokens}`);
  // Stopped early: not all 8 tasks ran.
  assert.ok(result.completed < 8, `completed ${result.completed}`);
  assert.ok(listTasks(repo, "pending").length > 0);
});

test("a run under budget finishes normally and records token totals", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "one", files: ["src/a.ts"] }]);
  const USAGE_AGENT = `
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", usage: { output_tokens: 50 } }));
`;
  const scriptFile = path.join(repo, "u.mjs");
  fs.writeFileSync(scriptFile, USAGE_AGENT);
  const config: WardroomConfig = {
    agents: { claude: { adapter: "claude", bin: process.execPath, args: [scriptFile] } },
    taskTimeoutMinutes: 5,
    review: "off",
    planner: "claude",
    budget: { tokens: 10000 },
  };
  const result = await runPool(repo, ["claude"], config, {}, { writedown: false });
  assert.equal(result.budgetStopped, false);
  assert.equal(result.completed, 1);
  assert.equal(result.tokens, 50);
});
