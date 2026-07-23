import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WardroomConfig } from "../src/config.ts";
import { checkFiles } from "../src/claims.ts";
import { listTasks, planTasks } from "../src/tasks.ts";
import { runWorker } from "../src/worker.ts";

// End-to-end worker tests with a FAKE agent: a node script standing in for a
// real CLI via the gemini (plain text) adapter. No network, no real agents.

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-worker-"));
}

// The fake agent appends its task marker to done.txt and echoes a summary.
function fakeAgentConfig(repo: string, script: string, timeoutMinutes = 5): WardroomConfig {
  const file = path.join(repo, "fake-agent.mjs");
  fs.writeFileSync(file, script);
  return {
    agents: {
      fake: { adapter: "gemini", bin: process.execPath, args: [file] },
    },
    taskTimeoutMinutes: timeoutMinutes,
  };
}

const WELL_BEHAVED = `
import fs from "fs";
const prompt = process.argv[2] ?? "";
const task = (prompt.match(/## Task (task-\\d+)/) ?? [])[1] ?? "unknown";
fs.appendFileSync("done.txt", task + "\\n");
console.log("worked on " + task + "; appended marker to done.txt");
`;

test("a single worker drains a dependent 3-task board in order", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [
    { title: "types", files: ["src/types.ts"] },
    { title: "api", files: ["src/api/**"], depends_on: ["$0"] },
    { title: "ui", files: ["src/ui/**"], depends_on: ["$0"] },
  ]);

  const statuses: string[] = [];
  const result = await runWorker(repo, "fake", fakeAgentConfig(repo, WELL_BEHAVED), {
    onStatus: (line) => statuses.push(line),
  });

  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.stopped, "board drained");
  assert.equal(
    fs.readFileSync(path.join(repo, "done.txt"), "utf8").trim().split("\n").join(","),
    "task-1,task-2,task-3"
  );
  assert.equal(listTasks(repo, "done").length, 3);
  assert.equal(checkFiles(repo).claims.length, 0);
  // Prompts told the agent its footprint; results were recorded on the board.
  const done = listTasks(repo, "done");
  assert.match(done[0].result ?? "", /worked on task-1/);
});

test("a failing verification command flips the task to failed with the log attached", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "breaks the build", files: ["src/x.ts"] }]);

  const config = fakeAgentConfig(repo, WELL_BEHAVED);
  config.verify = `node -e "console.error('2 tests failed'); process.exit(1)"`;

  const result = await runWorker(repo, "fake", config);
  assert.equal(result.failed, 1);
  const failed = listTasks(repo, "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].result ?? "", /verification failed/);
  assert.match(failed[0].result ?? "", /2 tests failed/);
  assert.equal(checkFiles(repo).claims.length, 0);
});

test("an agent that reports failure fails the task without running verification", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "doomed", files: ["src/y.ts"] }]);

  const config = fakeAgentConfig(
    repo,
    `console.log("cannot comply"); process.exit(3);`
  );
  config.verify = `node -e "fs.writeFileSync('verify-ran.txt','yes')"`;

  const result = await runWorker(repo, "fake", config);
  assert.equal(result.failed, 1);
  assert.match(listTasks(repo, "failed")[0].result ?? "", /exited with code 3/);
  assert.equal(fs.existsSync(path.join(repo, "verify-ran.txt")), false);
});

test("a hung agent is killed at the timeout and its leases are released", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [{ title: "hangs forever", files: ["src/z.ts"] }]);

  const config = fakeAgentConfig(repo, `setTimeout(() => {}, 120000);`);
  config.taskTimeoutMinutes = 0.02; // 1.2s

  const start = Date.now();
  const result = await runWorker(repo, "fake", config);
  assert.ok(Date.now() - start < 30_000);
  assert.equal(result.failed, 1);
  assert.match(listTasks(repo, "failed")[0].result ?? "", /timed out/);
  assert.equal(checkFiles(repo).claims.length, 0);
});

test("worker stops with a stuck report when dependencies can never be satisfied", async () => {
  const repo = makeRepo();
  planTasks(repo, "captain", [
    { title: "will fail", files: ["src/a.ts"] },
    { title: "depends on failure", files: ["src/b.ts"], depends_on: ["$0"] },
  ]);

  const config = fakeAgentConfig(repo, `console.log("nope"); process.exit(1);`);
  const result = await runWorker(repo, "fake", config);

  assert.equal(result.failed, 1);
  assert.match(result.stopped, /stuck/);
  assert.equal(listTasks(repo, "pending").length, 1);
});
