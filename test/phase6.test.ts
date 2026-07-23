import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WardroomConfig } from "../src/config.ts";
import { interpretCommand } from "../src/conductor.ts";
import { startSession } from "../src/session.ts";
import { claimNextTask, listTasks, planTasks } from "../src/tasks.ts";

function makeGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-p6-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

function fakeConfig(repo: string, agents: string[], script: string, extra: Partial<WardroomConfig> = {}): WardroomConfig {
  const file = path.join(repo, "fake.mjs");
  fs.writeFileSync(file, script);
  const config: WardroomConfig = { agents: {}, taskTimeoutMinutes: 5, review: "off", planner: agents[0], ...extra };
  for (const a of agents) config.agents[a] = { adapter: "gemini", bin: process.execPath, args: [file, a] };
  return config;
}

// ── directed assignment ───────────────────────────────────────────────────────

test("an assigned task is only claimable by its assignee", () => {
  const repo = makeGitRepo();
  planTasks(repo, "conductor", [{ title: "codex only", files: ["src/a.ts"], assignee: "codex" }]);

  // Claude cannot take a task assigned to codex.
  const wrong = claimNextTask(repo, "claude");
  assert.equal(wrong.status, "empty");
  // Codex can.
  const right = claimNextTask(repo, "codex");
  assert.equal(right.status, "claimed");
  assert.equal(right.status === "claimed" && right.task.assignee, "codex");
});

test("delegation is a task assigned to a peer (via plan_tasks assignee)", () => {
  const repo = makeGitRepo();
  // claude, mid-work, delegates the tests to codex.
  planTasks(repo, "claude", [{ title: "write tests", files: ["test/x.ts"], assignee: "codex" }]);
  const t = listTasks(repo)[0];
  assert.equal(t.assignee, "codex");
  assert.equal(t.createdBy, "claude");
  assert.equal(claimNextTask(repo, "claude").status, "empty");
  assert.equal(claimNextTask(repo, "codex").status, "claimed");
});

// ── conductor ─────────────────────────────────────────────────────────────────

test("the conductor turns a command into board tasks with assignees", async () => {
  const repo = makeGitRepo();
  const CONDUCTOR = `
console.log('\`\`\`json');
console.log('[{"title":"login endpoint","files":["src/auth.ts"],"assignee":"claude"},{"title":"login tests","files":["test/auth.ts"],"assignee":"codex","depends_on":["$0"]}]');
console.log('\`\`\`');
`;
  const config = fakeConfig(repo, ["claude", "codex"], CONDUCTOR, { conductor: "claude" });
  const { created } = await interpretCommand(repo, config, ["claude", "codex"], "add a login endpoint with tests");
  assert.equal(created.length, 2);
  assert.equal(created[0].assignee, "claude");
  assert.equal(created[1].assignee, "codex");
  assert.equal(created[1].dependsOn[0], created[0].id);
});

test("the conductor returns a note when a command needs no board work", async () => {
  const repo = makeGitRepo();
  const CONDUCTOR = `console.log("Nothing to do — the board already covers that.");`;
  const config = fakeConfig(repo, ["claude"], CONDUCTOR, { conductor: "claude" });
  const { created, note } = await interpretCommand(repo, config, ["claude"], "status?");
  assert.equal(created.length, 0);
  assert.match(note ?? "", /Nothing to do/);
});

// ── keep-alive session ────────────────────────────────────────────────────────

test("a session's crew stays alive on an empty board and picks up tasks added later", async () => {
  const repo = makeGitRepo();
  const AGENT = `
import fs from "fs";
const me = process.argv[2];
const id = ((process.argv[3] ?? "").match(/task-(\\d+)/) ?? [])[1] ?? "?";
fs.appendFileSync("did.txt", me + " task-" + id + "\\n");
console.log(me + " did task-" + id);
`;
  const config = fakeConfig(repo, ["claude"], AGENT);
  const session = startSession(repo, ["claude"], config, {});

  // Board starts empty; the worker is idling. Add a task after a beat.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(repo, "did.txt")), false);

  planTasks(repo, "conductor", [{ title: "late task", files: ["src/x.ts"] }]);

  // Give the keep-alive worker time to notice and run it.
  await new Promise((r) => setTimeout(r, 2500));
  const result = await session.stop();

  assert.equal(result.completed, 1);
  assert.match(fs.readFileSync(path.join(repo, "did.txt"), "utf8"), /claude task-1/);
});

test("an idle agent waits for peer-assigned work, then runs a task delegated to it", async () => {
  const repo = makeGitRepo();
  const AGENT = `
import fs from "fs";
const me = process.argv[2];
const id = ((process.argv[3] ?? "").match(/task-(\\d+)/) ?? [])[1] ?? "?";
fs.appendFileSync("owners.txt", me + ":" + id + "\\n");
console.log(me + " did " + id);
`;
  const config = fakeConfig(repo, ["claude", "codex"], AGENT);
  const session = startSession(repo, ["claude", "codex"], config, {});

  // Only work on the board is assigned to codex. The bug was that claude,
  // finding nothing it can claim, declared itself "stuck" and exited — so it
  // was gone when work was later delegated to it.
  planTasks(repo, "conductor", [{ title: "codex only", files: ["src/c.ts"], assignee: "codex" }]);
  await new Promise((r) => setTimeout(r, 2500));

  // Now delegate a task to claude. A correct worker is still alive and runs it.
  planTasks(repo, "conductor", [{ title: "for claude", files: ["src/x.ts"], assignee: "claude" }]);
  await new Promise((r) => setTimeout(r, 3500));
  await session.stop();

  const owners = fs.readFileSync(path.join(repo, "owners.txt"), "utf8").trim().split("\n");
  assert.ok(owners.includes("codex:1"), owners.join(","));
  assert.ok(owners.includes("claude:2"), "claude never ran the delegated task: " + owners.join(","));
});

test("delegated (assigned) tasks route to the right agent in a live session", async () => {
  const repo = makeGitRepo();
  const AGENT = `
import fs from "fs";
const me = process.argv[2];
const id = ((process.argv[3] ?? "").match(/task-(\\d+)/) ?? [])[1] ?? "?";
fs.appendFileSync("owners.txt", me + ":" + id + "\\n");
console.log(me + " did " + id);
`;
  const config = fakeConfig(repo, ["claude", "codex"], AGENT);
  const session = startSession(repo, ["claude", "codex"], config, {});

  // Conductor-style dispatch: one task to each agent by assignee.
  planTasks(repo, "conductor", [
    { title: "api", files: ["src/api.ts"], assignee: "claude" },
    { title: "tests", files: ["test/api.ts"], assignee: "codex" },
  ]);

  await new Promise((r) => setTimeout(r, 3000));
  await session.stop();

  const owners = fs.readFileSync(path.join(repo, "owners.txt"), "utf8").trim().split("\n").sort();
  // task-1 (api) was done by claude, task-2 (tests) by codex.
  assert.ok(owners.includes("claude:1"), owners.join(","));
  assert.ok(owners.includes("codex:2"), owners.join(","));
});
