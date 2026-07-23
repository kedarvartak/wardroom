import type { TaskStatus } from "../tasks.ts";

// ── pure presentation helpers ─────────────────────────────────────────────────
// No Ink, no React: everything here runs under Node's type-stripping, so it is
// directly testable and reusable by non-TUI renderers.

export const SPINNER = ["✶", "✻", "✽", "❋", "✽", "✻"];

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  claimed: "◐",
  review: "◑",
  done: "●",
  failed: "✗",
};

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// The transcript is append-only; each item renders once into scrollback via
// Ink's <Static> and is never repainted — exactly Claude Code's model.
export type TranscriptItem =
  | { kind: "banner"; project: string; crew: string[] }
  | { kind: "user"; text: string }
  | { kind: "conductor"; text: string }
  | { kind: "agent"; agent: string; note: "start" | "done" | "fail"; text: string }
  | { kind: "talk"; from: string; to: string; note: string; body: string }
  | { kind: "info"; text: string };
