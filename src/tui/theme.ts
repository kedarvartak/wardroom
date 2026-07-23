// ── palette ───────────────────────────────────────────────────────────────────
// One place for every color the TUI uses. Hex strings, consumed by Ink's
// <Text color>/<Box borderColor>. The accent is the conductor's voice; each
// agent keeps a stable identity color everywhere it appears.

export const theme = {
  accent: "#d77757",
  text: "#d6dfec",
  dim: "#7a899e",
  faint: "#546276",
  border: "#3a4658",
  good: "#7bd88f",
  warn: "#e2b25e",
  bad: "#e67878",
};

const AGENT_COLORS: Record<string, string> = {
  claude: "#60cad8",
  codex: "#7bd88f",
  gemini: "#b493ff",
};

export function agentColor(name: string): string {
  if (AGENT_COLORS[name]) return AGENT_COLORS[name];
  // Instances share the family color: claude-2 renders like claude.
  const family = Object.keys(AGENT_COLORS).find(
    (v) => name.toLowerCase().startsWith(`${v}-`) || name.toLowerCase().startsWith(`${v}_`)
  );
  return family ? AGENT_COLORS[family] : theme.warn;
}
