// ── wardroom/core ─────────────────────────────────────────────────────────────
// The coordination core as an importable library, for embedding wardroom's
// multi-agent protocol in OTHER harnesses (see integrations/pi). Everything
// here is harness-agnostic by construction: plain functions over plain files
// under `<repo>/.memo/`, safe for concurrent callers across processes. The
// MCP server (mcp.ts) and the wardroom CLI are just two consumers of exactly
// this surface — an extension host is a third.

export {
  anyPendingCanProgress,
  claimNextTask,
  completeTask,
  failTask,
  getTask,
  listTasks,
  planTasks,
  releaseTask,
  renderBoard,
  requeueStaleClaims,
} from "./tasks.ts";
export type { ClaimNextResult, Task, TaskInput, TaskStatus } from "./tasks.ts";

export { activeClaims, checkFiles, claimFiles, pathsOverlap, releaseFiles } from "./claims.ts";
export type { Claim, ClaimConflict } from "./claims.ts";

export { crosstalk, getMessages, openQuestions, sendMessage, unreadCount } from "./messages.ts";
export type { AgentMessage, MessageKind } from "./messages.ts";

export { getEvents, postEvent } from "./events.ts";
export { getContext } from "./context.ts";

export { forgetMemory, listMemory, memoryBrief, pinMemory, remember, verifyMemory } from "./memory.ts";
export type { MemoryItem, MemoryKind } from "./memory.ts";

export { readMemo, writeSession } from "./writedown.ts";
export { computeStats, renderStats } from "./stats.ts";
