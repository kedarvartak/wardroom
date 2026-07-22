import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { pathsOverlap } from "./claims.ts";

// ── git helpers for footprint telemetry and review diffs ──────────────────────
// Best-effort: if the repo isn't a git checkout (or git isn't available), these
// degrade to empty results rather than throwing — telemetry and review are
// advisory, not load-bearing.

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

// Set of paths with uncommitted changes (modified, added, untracked), repo-relative.
export function changedFiles(repoPath: string): Set<string> {
  const out = git(repoPath, ["status", "--porcelain", "--untracked-files=all"]);
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // porcelain format: "XY <path>" (or "XY <old> -> <new>" for renames)
    const p = line.slice(3).trim();
    const renamed = p.includes(" -> ") ? p.split(" -> ")[1] : p;
    files.add(renamed.replace(/^"|"$/g, ""));
  }
  return files;
}

// Footprint telemetry for a task, scoped to its own declared paths so it is
// safe under concurrency: peers edit files outside this footprint (the
// scheduler guarantees disjointness), so looking only at paths matching the
// declared globs never attributes a peer's change to this task.
//
//   actualFiles — declared paths that were in fact modified.
//   drift       — declared paths that were NOT touched (over-declaration).
//
// Over-declaration is the reliable, useful planning signal here; edits OUTSIDE
// a footprint are already prevented at edit time by the file-lease system.
export function footprintTelemetry(
  repoPath: string,
  declared: string[]
): { actualFiles: string[]; drift: string[] } {
  if (declared.length === 0) return { actualFiles: [], drift: [] };
  const changed = [...changedFiles(repoPath)];
  const actualFiles = changed.filter((f) => declared.some((glob) => pathsOverlap(glob, f)));
  const drift = declared.filter((decl) => !actualFiles.some((f) => pathsOverlap(decl, f)));
  return { actualFiles, drift };
}

// ── change records ────────────────────────────────────────────────────────────
// What a task actually changed, so the human always knows what the agent did.
// Scoped to the task's footprint (globs, matched by our own overlap check, since
// git pathspecs don't handle `**` reliably), which is concurrency-safe because
// footprints are disjoint.

export type FileChange = { path: string; added: number; deleted: number; status: "M" | "A" | "D" };
export type ChangeRecord = { files: FileChange[]; added: number; deleted: number };

function countLines(repoPath: string, rel: string): number {
  try {
    const buf = fs.readFileSync(path.join(repoPath, rel));
    if (buf.includes(0)) return 0; // binary
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
  } catch {
    return 0;
  }
}

// Concrete changed paths in the working tree (no globs), with per-file +/-.
function allChanges(repoPath: string): FileChange[] {
  const changes: FileChange[] = [];

  // tracked modifications/deletions vs HEAD
  for (const line of git(repoPath, ["diff", "--numstat", "HEAD"]).split("\n")) {
    if (!line.trim()) continue;
    const [a, d, p] = line.split("\t");
    if (!p) continue;
    changes.push({
      path: p,
      added: a === "-" ? 0 : Number(a) || 0,
      deleted: d === "-" ? 0 : Number(d) || 0,
      status: a === "0" && Number(d) > 0 ? "M" : "M",
    });
  }
  // untracked (newly created) files
  for (const p of git(repoPath, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    if (!p.trim()) continue;
    changes.push({ path: p, added: countLines(repoPath, p), deleted: 0, status: "A" });
  }
  return changes;
}

// The change record for a task, filtered to its footprint.
export function changeStat(repoPath: string, footprint: string[]): ChangeRecord {
  const inFootprint =
    footprint.length === 0
      ? []
      : allChanges(repoPath).filter((c) => footprint.some((g) => pathsOverlap(g, c.path)));
  return {
    files: inFootprint,
    added: inFootprint.reduce((s, c) => s + c.added, 0),
    deleted: inFootprint.reduce((s, c) => s + c.deleted, 0),
  };
}

// A one-line stat like "2 files · +18 -4", or "" when nothing changed.
export function changeSummary(rec?: ChangeRecord): string {
  if (!rec || rec.files.length === 0) return "";
  return `${rec.files.length} file${rec.files.length > 1 ? "s" : ""} · +${rec.added} -${rec.deleted}`;
}

// Diff of the given files (or the whole working tree if none), truncated so a
// large diff doesn't blow the reviewer's context.
export function diffOf(repoPath: string, files: string[], maxChars = 6000): string {
  const args = ["diff", "--no-color", "HEAD", "--"];
  const raw = files.length > 0 ? git(repoPath, [...args, ...files]) : git(repoPath, ["diff", "--no-color", "HEAD"]);
  if (!raw.trim()) {
    // Untracked new files won't show in `git diff HEAD`; fall back to a listing.
    return files.length > 0 ? `(no tracked diff; files: ${files.join(", ")})` : "(no diff)";
  }
  return raw.length > maxChars ? raw.slice(0, maxChars) + "\n... (diff truncated)" : raw;
}
