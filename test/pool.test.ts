import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkFiles, claimFiles } from "../src/claims.ts";
import type { WardroomConfig } from "../src/config.ts";
import { sendMessage } from "../src/messages.ts";
import { runPool } from "../src/pool.ts";
import { renderPool } from "../src/renderer.ts";
import { claimNextTask, listTasks, planTasks, requeueStaleClaims } from "../src/tasks.ts";

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-pool-"));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  return repo;
}

// Fake agents via the gemini (plain-text) adapter: each records which task it
// worked and how long it took, so we can assert concurrency and ownership.
function poolConfig(repo: string, agents: string[], script: string, timeoutMinutes = 5): WardroomConfig {
  const file = path.join(repo, "fake-agent.mjs");
  fs.writeFileSync(file, script);
  const config: WardroomConfig = { agents: {}, taskTimeoutMinutes: timeoutMinutes };
  for (const a of agents) {
    config.agents[a] = { adapter: "gemini", bin: process.execPath, args: [file, a] };
  }
  return config;
}

const RECORD_AGENT = `
import fs from "fs";
const agent = process.argv[2];
const prompt = process.argv[3] ?? "";
const task = (prompt.match(/## Task (task-\\d+)/) ?? [])[1] ?? "unknown";
fs.appendFileSync("worklog.txt", agent + " " + task + " " + Date.now() + "\\n");
console.log(agent + " completed " + task);
`;

test("a pool of three agents drains a 6-task board with zero collisions", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [
    { title: "t1", files: ["src/a.ts"] },
    { title: "t2", files: ["src/b.ts"] },
    { title: "t3", files: ["src/c.ts"] },
    { title: "t4", files: ["src/d.ts"] },
    { title: "t5", files: ["src/e.ts"] },
    { title: "t6", files: ["src/f.ts"] },
  ]);

  const result = await runPool(repo, ["claude", "codex", "gemini"], poolConfig(repo, ["claude", "codex", "gemini"], RECORD_AGENT), {}, { writedown: false });

  assert.equal(result.completed, 6);
  assert.equal(result.failed, 0);
  assert.equal(listTasks(repo, "done").length, 6);
  assert.equal(checkFiles(repo).claims.length, 0);

  // Every task done exactly once, and by exactly one agent (no double-claims).
  const worklog = fs.readFileSync(path.join(repo, "worklog.txt"), "utf8").trim().split("\n");
  assert.equal(worklog.length, 6);
  const taskOwners = new Map<string, string>();
  for (const line of worklog) {
    const [agent, task] = line.split(" ");
    assert.equal(taskOwners.has(task), false, `${task} was worked twice`);
    taskOwners.set(task, agent);
  }
  assert.equal(taskOwners.size, 6);

  // At least two different agents actually did work (real parallelism).
  assert.ok(new Set([...taskOwners.values()]).size >= 2);
});

test("work is spread across agents, not serialized through one", async () => {
  const repo = makeRepo();
  // A slow agent so that if work were serial, one agent would take all tasks;
  // concurrency means the others grab tasks while the first is busy.
  const SLOW = `
import fs from "fs";
const agent = process.argv[2];
const task = ((process.argv[3] ?? "").match(/## Task (task-\\d+)/) ?? [])[1] ?? "?";
const wait = Date.now() + 150;
while (Date.now() < wait) {}
fs.appendFileSync("worklog.txt", agent + "\\n");
console.log(agent + " did " + task);
`;
  planTasks(repo, "captain", Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, files: [`src/${i}.ts`] })));

  const result = await runPool(repo, ["a", "b", "c"], poolConfig(repo, ["a", "b", "c"], SLOW), {}, { writedown: false });
  assert.equal(result.completed, 6);
  const workers = new Set(fs.readFileSync(path.join(repo, "worklog.txt"), "utf8").trim().split("\n"));
  assert.ok(workers.size >= 2, "expected multiple agents to have done work concurrently");
});

test("requeueStaleClaims returns an orphaned task to the board", () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "orphan me", files: ["src/x.ts"] }]);

  // Simulate a crashed run: task claimed, but its lease has expired.
  const claimed = claimNextTask(repo, "ghost");
  assert.equal(claimed.status, "claimed");
  const claimsFile = path.join(repo, ".memo", "claims.json");
  const claims = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
  claims.claims[0].expires = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(claimsFile, JSON.stringify(claims));

  const requeued = requeueStaleClaims(repo);
  assert.deepEqual(requeued, ["task-1"]);
  assert.equal(listTasks(repo, "pending").length, 1);
  assert.equal(listTasks(repo, "claimed").length, 0);
});

test("a pool recovers a task orphaned by a prior crashed run", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "recover me", files: ["src/y.ts"] }]);

  // Prior run claimed it, then died; lease expired.
  claimNextTask(repo, "deadworker");
  const claimsFile = path.join(repo, ".memo", "claims.json");
  const claims = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
  claims.claims[0].expires = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(claimsFile, JSON.stringify(claims));
  assert.equal(listTasks(repo, "claimed").length, 1);

  const result = await runPool(repo, ["fresh"], poolConfig(repo, ["fresh"], RECORD_AGENT), {}, { writedown: false });
  assert.deepEqual(result.requeued, ["task-1"]);
  assert.equal(result.completed, 1);
  assert.equal(listTasks(repo, "done").length, 1);
});

test("healthy in-flight tasks are never requeued", () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "in flight", files: ["src/z.ts"] }]);
  claimNextTask(repo, "worker"); // holds a live lease (60min TTL)
  assert.deepEqual(requeueStaleClaims(repo), []);
  assert.equal(listTasks(repo, "claimed").length, 1);
});

test("the pool writes a session writedown on exit", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "do it", files: ["src/w.ts"] }]);
  const result = await runPool(repo, ["solo"], poolConfig(repo, ["solo"], RECORD_AGENT));
  assert.ok(result.writedownFile);
  assert.ok(fs.existsSync(path.join(repo, ".memo", "sessions")));
  assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /Pool run/);
});

test("agent-to-agent crosstalk during a run appears in the pool view", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "chatty", files: ["src/c.ts"] }]);
  // An agent CLI posts a question mid-task (here, pre-seeded).
  sendMessage(repo, "codex", "claude", "does task-1 change the API?", "question");
  sendMessage(repo, "claude", "captain", "should I keep the legacy route?", "question");

  const state = {
    startedAt: Date.now() - 5000,
    panes: [
      { agent: "claude", phase: "working" as const, taskId: "task-1", taskTitle: "chatty", lines: ["Editing src/c.ts"], tokens: 40, completed: 0, failed: 0 },
      { agent: "codex", phase: "waiting" as const, lines: [], tokens: 0, completed: 1, failed: 0 },
    ],
  };
  const view = renderPool(repo, state, 88);
  assert.match(view, /claude/);
  assert.match(view, /codex/);
  assert.match(view, /Editing src\/c\.ts/);
  assert.match(view, /does task-1 change the API\?/);
  assert.match(view, /question\(s\) for you/);
});
