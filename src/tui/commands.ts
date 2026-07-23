// ── console slash commands ────────────────────────────────────────────────────
// Pure parser: a typed action out of a "/..." line, no Ink and no side effects,
// so it is directly testable. The app executes actions against the session.
// Anything NOT starting with "/" is a conductor command; an unknown "/x" is an
// error rather than being sent to the conductor (typos should not cost tokens).

export type SlashCommand =
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "crew" }
  | { kind: "stats" }
  | { kind: "say"; body: string }
  | { kind: "add"; name: string; vendor?: string }
  | { kind: "drop"; name: string }
  | { kind: "conductor"; name: string }
  | { kind: "review"; policy: string }
  | { kind: "budget"; show?: boolean; clear?: boolean; tokens?: number; usd?: number }
  | { kind: "verify"; show?: boolean; clear?: boolean; command?: string }
  | { kind: "error"; message: string };

export const SLASH_HELP: string[] = [
  "/add <name> [vendor]      hire an agent, live — claude-2 infers the claude preset",
  "/drop <name>              stand an agent down (finishes in-flight work first)",
  "/conductor <name>         who interprets your commands and plans",
  "/review off|changed-files|all   cross-agent review policy",
  "/budget 500k | 2m | $5 | off    session spend cap (tokens or dollars); bare /budget shows it",
  "/verify <shell cmd> | off       gate run before a task completes (e.g. npm test); bare /verify shows it",
  "/crew                     roster: who is on, adapters, conductor",
  "/stats                    parallelism report: speedup, utilization, ready-wait, critical path",
  "/say <message>            broadcast to every agent as the captain",
  "/quit                     stand the crew down and leave",
  "changes persist to wardroom.json; anything without / goes to the conductor",
];

export function parseSlash(line: string): SlashCommand | null {
  if (!line.startsWith("/")) return null;
  const [head, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest[0];

  switch (head) {
    case "help":
      return { kind: "help" };
    case "quit":
    case "exit":
      return { kind: "quit" };
    case "crew":
    case "config":
      return { kind: "crew" };
    case "stats":
      return { kind: "stats" };
    case "say": {
      const body = rest.join(" ").trim();
      return body ? { kind: "say", body } : { kind: "error", message: "usage: /say <message>" };
    }
    case "add":
      return arg
        ? { kind: "add", name: arg.toLowerCase(), vendor: rest[1]?.toLowerCase() }
        : { kind: "error", message: "usage: /add <name> [claude|codex|gemini]" };
    case "drop":
      return arg ? { kind: "drop", name: arg.toLowerCase() } : { kind: "error", message: "usage: /drop <name>" };
    case "conductor":
      return arg
        ? { kind: "conductor", name: arg.toLowerCase() }
        : { kind: "error", message: "usage: /conductor <agent>" };
    case "review":
      return arg ? { kind: "review", policy: arg.toLowerCase() } : { kind: "error", message: "usage: /review off|changed-files|all" };
    case "budget": {
      if (!arg) return { kind: "budget", show: true };
      if (arg.toLowerCase() === "off") return { kind: "budget", clear: true };
      const usd = arg.match(/^\$(\d+(?:\.\d+)?)$/) ?? arg.match(/^(\d+(?:\.\d+)?)usd$/i);
      if (usd) return { kind: "budget", usd: Number(usd[1]) };
      const tok = arg.match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
      if (tok) {
        const scale = tok[2]?.toLowerCase() === "m" ? 1_000_000 : tok[2] ? 1_000 : 1;
        return { kind: "budget", tokens: Math.round(Number(tok[1]) * scale) };
      }
      return { kind: "error", message: "usage: /budget 500k | 2m | 120000 | $5 | off" };
    }
    case "verify": {
      if (!arg) return { kind: "verify", show: true };
      if (rest.length === 1 && arg.toLowerCase() === "off") return { kind: "verify", clear: true };
      return { kind: "verify", command: rest.join(" ") };
    }
    default:
      return { kind: "error", message: `unknown command /${head} — /help lists them` };
  }
}
