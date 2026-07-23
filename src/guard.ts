import path from "path";
import { checkFiles } from "./claims.ts";

// ── enforcement guard ─────────────────────────────────────────────────────────
// Advisory leases become opt-in *enforced* here. An agent's harness runs this
// before every file edit (Claude Code PreToolUse hook, or equivalent); it reads
// the tool call on stdin, and if the target file is leased by ANOTHER agent, it
// denies the edit. Cooperative agents already check claims; this catches the
// ones that forget.
//
// Fail-open by design: any parse error, missing repo, or unknown tool ALLOWS
// the edit. A coordination guard must never wedge an agent's whole session
// because of its own bug — the lease system is a safety rail, not a gate.

type HookInput = {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

// Extract the file paths a tool call will modify. Read-only and shell tools
// return [] (nothing to guard).
export function editedPaths(toolName: string, toolInput: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) paths.push(v);
  };
  switch (toolName) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "Update":
    case "create_file":
    case "str_replace":
      push(toolInput.file_path ?? toolInput.path);
      break;
    case "NotebookEdit":
      push(toolInput.notebook_path);
      break;
    default:
      break;
  }
  return paths;
}

export type GuardDecision = { allow: boolean; reason?: string };

export function evaluate(
  repoPath: string,
  agent: string,
  toolName: string,
  toolInput: Record<string, unknown>
): GuardDecision {
  const targets = editedPaths(toolName, toolInput);
  if (targets.length === 0) return { allow: true };

  const rel = targets.map((p) => (path.isAbsolute(p) ? path.relative(repoPath, p) : p));
  let conflicts;
  try {
    conflicts = checkFiles(repoPath, rel).conflicts;
  } catch {
    return { allow: true }; // fail-open
  }

  const me = agent.toLowerCase();
  const blocking = conflicts.filter((c) => c.holder !== me);
  if (blocking.length === 0) return { allow: true };

  const first = blocking[0];
  return {
    allow: false,
    reason:
      `wardroom: ${first.holder} holds a lease on ${first.conflictsWith} (${first.reason}, until ${first.expires}). ` +
      `Do not edit ${first.path} — claim other work or wait for the lease to expire.`,
  };
}

// Entry point for `wardroom guard`. Reads the hook JSON from stdin, decides,
// and emits a Claude-Code-compatible deny (or stays silent to allow).
export async function runGuard(agent: string, repoOverride?: string): Promise<number> {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return 0; // no parseable input -> allow
  }

  const repoPath = repoOverride || input.cwd || process.cwd();
  const decision = evaluate(
    repoPath,
    agent,
    String(input.tool_name ?? ""),
    (input.tool_input ?? {}) as Record<string, unknown>
  );

  if (decision.allow) return 0;

  // Claude Code PreToolUse: a JSON deny decision on stdout blocks the tool and
  // feeds the reason back to the model.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    }) + "\n"
  );
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
