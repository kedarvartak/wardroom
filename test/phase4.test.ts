import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WardroomConfig } from "../src/config.ts";
import { footprintTelemetry } from "../src/git.ts";
import { parseTaskPlan, planFromGoal } from "../src/planner.ts";
import { runPool } from "../src/pool.ts";
import { listTasks, planTasks } from "../src/tasks.ts";

function makeGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-p4-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

function agentConfig(repo: string, agents: string[], script: string, extra: Partial<WardroomConfig> = {}): WardroomConfig {
  const file = path.join(repo, "fake-agent.mjs");
  fs.writeFileSync(file, script);
  const config: WardroomConfig = { agents: {}, taskTimeoutMinutes: 5, review: "off", planner: agents[0], ...extra };
  for (const a of agents) config.agents[a] = { adapter: "gemini", bin: process.execPath, args: [file, a] };
  return config;
}

// ── planner ───────────────────────────────────────────────────────────────────

test("parseTaskPlan extracts a fenced JSON task array", () => {
  const text = "Here is the plan:\n```json\n[{\"title\":\"types\",\"files\":[\"src/types.ts\"]},{\"title\":\"api\",\"files\":[\"src/api.ts\"],\"depends_on\":[\"$0\"]}]\n```\nDone.";
  const tasks = parseTaskPlan(text);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "types");
  assert.deepEqual(tasks[1].depends_on, ["$0"]);
});

test("parseTaskPlan falls back to a bare array and rejects junk", () => {
  assert.equal(parseTaskPlan('[{"title":"only"}]').length, 1);
  assert.throws(() => parseTaskPlan("no json here"), /no JSON/);
  assert.throws(() => parseTaskPlan("```json\n[]\n```"), /non-empty/);
});

test("planFromGoal runs the planner agent and returns tasks", async () => {
  const repo = makeGitRepo();
  const PLANNER = `
console.log("planning");
console.log('\`\`\`json');
console.log('[{"title":"build types","files":["src/types.ts"]},{"title":"build api","files":["src/api.ts"],"depends_on":["$0"]}]');
console.log('\`\`\`');
`;
  const config = agentConfig(repo, ["claude"], PLANNER, { planner: "claude" });
  const tasks = await planFromGoal(repo, config, "add a types module and an api");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].title, "build api");
  // And it commits cleanly to the board.
  const { created } = planTasks(repo, "captain", tasks);
  assert.equal(created[1].dependsOn[0], created[0].id);
});

// ── footprint telemetry ───────────────────────────────────────────────────────

test("footprintTelemetry reports touched-vs-declared, scoped to the footprint", () => {
  const repo = makeGitRepo();
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "changed\n"); // declared + touched
  fs.writeFileSync(path.join(repo, "peer.ts"), "peer\n"); // a peer's file, outside footprint

  const t = footprintTelemetry(repo, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(t.actualFiles, ["src/a.ts"]); // peer.ts is not attributed here
  assert.deepEqual(t.drift, ["src/b.ts"]); // declared but never touched
});

test("a pool records footprint drift when a declared file is not touched", async () => {
  const repo = makeGitRepo();
  planTasks(repo, "captain", [{ title: "over-declared", files: ["src/touched.ts", "src/ghost.ts"] }]);
  const AGENT = `
import fs from "fs";
fs.mkdirSync("src", { recursive: true });
fs.writeFileSync("src/touched.ts", "work\\n");   // touches only one declared file
console.log("done, edited src/touched.ts only");
`;
  const result = await runPool(repo, ["solo"], agentConfig(repo, ["solo"], AGENT), {}, { writedown: false });
  assert.equal(result.completed, 1);
  assert.equal(result.driftTasks, 1);
  assert.deepEqual(listTasks(repo, "done")[0].drift, ["src/ghost.ts"]);
});

// ── cross-agent review ────────────────────────────────────────────────────────

// An agent that behaves badly on its first attempt at a task and correctly on
// the retry, so the review loop must catch it and reopen it.
const BUGGY_THEN_FIXED = `
import fs from "fs";
const agent = process.argv[2];
const prompt = process.argv[3] ?? "";
const isReview = prompt.includes("reviewing another agent");
const task = (prompt.match(/task-(\\d+)/) ?? [])[1] ?? "0";
const stateFile = ".attempts-" + task;

if (isReview) {
  // Reviewer: approve only if the work file contains "FIXED".
  const work = fs.existsSync("work-" + task + ".txt") ? fs.readFileSync("work-" + task + ".txt","utf8") : "";
  if (work.includes("FIXED")) console.log("VERDICT: APPROVE looks correct");
  else console.log("VERDICT: REQUEST_CHANGES the output has a bug");
} else {
  const n = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile,"utf8")) : 0;
  fs.writeFileSync(stateFile, String(n+1));
  fs.writeFileSync("work-" + task + ".txt", n === 0 ? "BUGGY" : "FIXED");
  console.log(agent + " attempt " + (n+1) + " on task-" + task);
}
`;

test("a reviewing agent catches a bug and the reopen-fix-approve loop completes", async () => {
  const repo = makeGitRepo();
  planTasks(repo, "captain", [{ title: "risky change", files: ["src/risky.ts"] }]);

  const config = agentConfig(repo, ["author", "reviewer"], BUGGY_THEN_FIXED, { review: "all" });
  const result = await runPool(repo, ["author", "reviewer"], config, {}, { writedown: false });

  // First attempt was buggy -> reviewer requested changes -> reopened -> second
  // attempt fixed -> approved -> done. No operator intervention.
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.ok(result.reviewed >= 2, `expected >=2 reviews, got ${result.reviewed}`);
  const done = listTasks(repo, "done");
  assert.equal(done.length, 1);
  assert.match(done[0].result ?? "", /approved/);
  assert.equal((done[0].reviewAttempts ?? 0) >= 2, true);
});

test("review is skipped when only one agent is running (no peer to review)", async () => {
  const repo = makeGitRepo();
  planTasks(repo, "captain", [{ title: "solo work", files: ["src/s.ts"] }]);
  const config = agentConfig(repo, ["solo"], `console.log("did it");`, { review: "all" });
  const result = await runPool(repo, ["solo"], config, {}, { writedown: false });
  assert.equal(result.completed, 1);
  assert.equal(result.reviewed, 0); // nobody to review; completed directly
});
