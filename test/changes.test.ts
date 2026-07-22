import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changeStat, changeSummary } from "../src/git.ts";
import type { WardroomConfig } from "../src/config.ts";
import { runPool } from "../src/pool.ts";
import { getTask, listTasks, planTasks } from "../src/tasks.ts";

function gitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-chg-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "existing.ts"), "line1\nline2\nline3\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

test("changeStat reports created and modified files scoped to the footprint", () => {
  const repo = gitRepo();
  // modify a tracked file and create a new one within the footprint
  fs.writeFileSync(path.join(repo, "src", "existing.ts"), "line1\nchanged2\nline3\nline4\n");
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "a\nb\n");
  // and a file OUTSIDE the footprint (a peer's work)
  fs.writeFileSync(path.join(repo, "peer.ts"), "x\n");

  const rec = changeStat(repo, ["src/**"]);
  const paths = rec.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["src/existing.ts", "src/new.ts"]); // peer.ts excluded
  const created = rec.files.find((f) => f.path === "src/new.ts");
  assert.equal(created?.status, "A");
  assert.equal(created?.added, 2);
  assert.ok(rec.added > 0);
  assert.match(changeSummary(rec), /2 files · \+\d+ -\d+/);
});

test("changeStat is empty for a footprint that touched nothing", () => {
  const repo = gitRepo();
  assert.equal(changeStat(repo, ["docs/**"]).files.length, 0);
  assert.equal(changeSummary(undefined), "");
});

test("a pool run records what each task changed", async () => {
  const repo = gitRepo();
  planTasks(repo, "captain", [{ title: "edit existing", files: ["src/existing.ts"] }]);
  // fake agent that actually edits its footprint file
  const AGENT = `
import fs from "fs";
fs.writeFileSync("src/existing.ts", "line1\\nEDITED\\nline3\\nline4\\nline5\\n");
console.log("edited src/existing.ts");
`;
  const file = path.join(repo, "agent.mjs");
  fs.writeFileSync(file, AGENT);
  const config: WardroomConfig = {
    agents: { solo: { adapter: "gemini", bin: process.execPath, args: [file] } },
    taskTimeoutMinutes: 5,
    review: "off",
    planner: "solo",
  };

  const result = await runPool(repo, ["solo"], config, {}, { writedown: false });
  assert.equal(result.completed, 1);
  const task = getTask(repo, "task-1");
  assert.ok(task?.changes, "task should have a change record");
  assert.equal(task!.changes!.files[0].path, "src/existing.ts");
  assert.ok(task!.changes!.added > 0);
  // the diff was captured for `wardroom show`
  assert.match(task!.diff ?? "", /EDITED/);
});

test("getTask resolves a task and its recorded diff", async () => {
  const repo = gitRepo();
  planTasks(repo, "captain", [{ title: "make a file", files: ["src/made.ts"] }]);
  const AGENT = `import fs from "fs"; fs.writeFileSync("src/made.ts","hello\\nworld\\n"); console.log("made it");`;
  const file = path.join(repo, "a.mjs");
  fs.writeFileSync(file, AGENT);
  const config: WardroomConfig = {
    agents: { solo: { adapter: "gemini", bin: process.execPath, args: [file] } },
    taskTimeoutMinutes: 5,
    review: "off",
    planner: "solo",
  };
  await runPool(repo, ["solo"], config, {}, { writedown: false });
  const t = getTask(repo, "task-1");
  assert.equal(t?.changes?.files[0].path, "src/made.ts");
  assert.equal(t?.changes?.files[0].status, "A");
  assert.equal(listTasks(repo).length, 1);
});
