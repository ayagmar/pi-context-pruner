import type { PrunerProfile, PrunerProfileName } from "./types.js";

export const EXTENSION_NAME = "pi-context-pruner";
export const EXTENSION_COMMAND = "context-pruner";
export const STATUS_KEY = "context-pruner";
export const WIDGET_KEY = "context-pruner-events";
export const ACTION_HISTORY_LIMIT = 10;

export const DEFAULT_PROFILE: PrunerProfileName = "balanced";
export const DEFAULT_OBSERVABILITY_ENABLED = true;

/**
 * Cache-safe defaults:
 * - late activation for context pruning
 * - hysteresis to avoid prune/unprune flapping
 */
export const PROFILES: Record<PrunerProfileName, PrunerProfile> = {
  balanced: {
    activateAtContextRatio: 0.8,
    deactivateAtContextRatio: 0.7,
    keepRecentToolResults: 10,
    keepRecentHeavyToolResults: 6,
    heavyToolResultChars: 6_000,
    maxCharsForOldToolResult: 2_500,
    headChars: 1_200,
    tailChars: 900,
    keepErrorsFull: true,
    keepToolsFull: ["edit", "write"],
  },
  aggressive: {
    activateAtContextRatio: 0.7,
    deactivateAtContextRatio: 0.55,
    keepRecentToolResults: 6,
    keepRecentHeavyToolResults: 3,
    heavyToolResultChars: 4_000,
    maxCharsForOldToolResult: 1_500,
    headChars: 700,
    tailChars: 500,
    keepErrorsFull: true,
    keepToolsFull: ["edit", "write"],
  },
};

/**
 * Codex-inspired stable truncation at tool-result ingest time.
 * This preserves prompt-cache stability better than mutating context every turn.
 */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 10_000;
export const TOOL_RESULT_TRUNCATE_HEAD_CHARS = 7_000;
export const TOOL_RESULT_TRUNCATE_TAIL_CHARS = 2_500;
export const TOOL_RESULT_TRUNCATED_MARKER = "[context-pruner:tool-result-truncated]";
