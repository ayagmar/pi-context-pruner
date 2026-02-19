import assert from "node:assert/strict";
import test from "node:test";
import type { ContextMessage, PrunerProfile } from "../src/types.js";
import { pruneContextMessages, shouldPruneForUsage } from "../src/pruner.js";

const TEST_PROFILE: PrunerProfile = {
  activateAtContextRatio: 0.5,
  deactivateAtContextRatio: 0.35,
  keepRecentToolResults: 1,
  keepRecentHeavyToolResults: 1,
  heavyToolResultChars: 40,
  maxCharsForOldToolResult: 20,
  headChars: 8,
  tailChars: 8,
  keepErrorsFull: true,
  keepToolsFull: ["edit"],
};

void test("shouldPruneForUsage uses hysteresis thresholds", () => {
  assert.equal(shouldPruneForUsage(undefined, TEST_PROFILE, false), false);
  assert.equal(shouldPruneForUsage({ tokens: 40, contextWindow: 100 }, TEST_PROFILE, false), false);
  assert.equal(shouldPruneForUsage({ tokens: 90, contextWindow: 100 }, TEST_PROFILE, false), true);

  assert.equal(shouldPruneForUsage({ tokens: 45, contextWindow: 100 }, TEST_PROFILE, true), true);
  assert.equal(shouldPruneForUsage({ tokens: 30, contextWindow: 100 }, TEST_PROFILE, true), false);
});

void test("pruneContextMessages trims older heavy tool results", () => {
  const heavyA = makeToolResult("bash", "A".repeat(90));
  const heavyB = makeToolResult("bash", "B".repeat(90));
  const heavyRecent = makeToolResult("bash", "C".repeat(90));

  const result = pruneContextMessages([heavyA, heavyB, heavyRecent], {
    profile: TEST_PROFILE,
  });

  assert.equal(result.changed, 2);

  const firstText = getText(result.messages[0]);
  const secondText = getText(result.messages[1]);
  const recentText = getText(result.messages[2]);

  assert.match(firstText, /\[context-pruner\] Older bash result trimmed/);
  assert.match(secondText, /\[context-pruner\] Older bash result trimmed/);
  assert.equal(recentText, "C".repeat(90));
});

void test("pruneContextMessages keeps errors and keepToolsFull entries intact", () => {
  const errorResult = makeToolResult("bash", "E".repeat(90), true);
  const editResult = makeToolResult("edit", "D".repeat(90));
  const bashResult = makeToolResult("bash", "B".repeat(90));

  const profile: PrunerProfile = {
    ...TEST_PROFILE,
    keepRecentToolResults: 0,
    keepRecentHeavyToolResults: 0,
  };

  const result = pruneContextMessages([errorResult, editResult, bashResult], {
    profile,
  });

  assert.equal(result.changed, 1);
  assert.equal(getText(result.messages[0]), "E".repeat(90));
  assert.equal(getText(result.messages[1]), "D".repeat(90));
  assert.match(getText(result.messages[2]), /\[context-pruner\] Older bash result trimmed/);
});

function makeToolResult(toolName: string, text: string, isError = false): ContextMessage {
  return {
    role: "toolResult",
    toolName,
    isError,
    content: [{ type: "text", text }],
  };
}

function getText(message: ContextMessage | undefined): string {
  const content = message?.["content"];
  if (!Array.isArray(content) || content.length === 0) return "";

  const first = content[0] as { type?: unknown; text?: unknown };
  return first.type === "text" && typeof first.text === "string" ? first.text : "";
}
