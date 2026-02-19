import type {
  ContextMessage,
  ContextUsageSnapshot,
  PruneResult,
  PrunerProfile,
  ToolResultContentPart,
  ToolResultMessage,
} from "./types.js";

interface ToolResultMeta {
  index: number;
  toolName: string;
  textChars: number;
  imageCount: number;
  isError: boolean;
}

export interface PruneOptions {
  profile: PrunerProfile;
}

export function shouldPruneForUsage(
  usage: ContextUsageSnapshot | undefined,
  profile: PrunerProfile,
  previouslyActive = false
): boolean {
  if (!usage || usage.contextWindow <= 0) return previouslyActive;

  const ratio = usage.tokens / usage.contextWindow;
  if (previouslyActive) {
    return ratio > profile.deactivateAtContextRatio;
  }

  return ratio >= profile.activateAtContextRatio;
}

export function pruneContextMessages(
  messages: readonly ContextMessage[],
  options: PruneOptions
): PruneResult {
  const toolResults: ToolResultMeta[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isToolResultMessage(message)) continue;

    const stats = getContentStats(message.content);
    toolResults.push({
      index,
      toolName: normalizeToolName(message.toolName),
      textChars: stats.text.length,
      imageCount: stats.imageCount,
      isError: Boolean(message.isError),
    });
  }

  if (toolResults.length === 0) {
    return { messages: [...messages], changed: 0 };
  }

  const keepRecent = new Set<number>(
    takeLast(toolResults, options.profile.keepRecentToolResults).map((item) => item.index)
  );

  const heavy = toolResults.filter(
    (item) => item.textChars > options.profile.heavyToolResultChars || item.imageCount > 0
  );
  const keepRecentHeavy = new Set<number>(
    takeLast(heavy, options.profile.keepRecentHeavyToolResults).map((item) => item.index)
  );

  const nextMessages: ContextMessage[] = [...messages];
  let changed = 0;

  for (const item of toolResults) {
    if (keepRecent.has(item.index) || keepRecentHeavy.has(item.index)) continue;
    if (options.profile.keepErrorsFull && item.isError) continue;
    if (options.profile.keepToolsFull.includes(item.toolName)) continue;

    const shouldShrink =
      item.textChars > options.profile.maxCharsForOldToolResult || item.imageCount > 0;
    if (!shouldShrink) continue;

    const original = nextMessages[item.index];
    if (!isToolResultMessage(original)) continue;

    nextMessages[item.index] = shrinkToolResultMessage(original, options.profile);
    changed += 1;
  }

  return { messages: nextMessages, changed };
}

function takeLast<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  return items.slice(-count);
}

export function isToolResultMessage(message: unknown): message is ToolResultMessage {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { role?: unknown }).role === "toolResult"
  );
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "tool";
}

function getContentStats(content: unknown): { text: string; imageCount: number } {
  if (!Array.isArray(content)) return { text: "", imageCount: 0 };

  const textParts: string[] = [];
  let imageCount = 0;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as ToolResultContentPart;

    if (typed.type === "text") {
      textParts.push(typeof typed.text === "string" ? typed.text : "");
      continue;
    }

    if (typed.type === "image") {
      imageCount += 1;
    }
  }

  return { text: textParts.join("\n"), imageCount };
}

function shrinkToolResultMessage(
  message: ToolResultMessage,
  profile: PrunerProfile
): ToolResultMessage {
  const stats = getContentStats(message.content);
  const toolName = normalizeToolName(message.toolName);
  const shortened = truncateMiddle(stats.text, profile.headChars, profile.tailChars);

  const prefix =
    `[context-pruner] Older ${toolName} result trimmed ` +
    `(was ${stats.text.length.toLocaleString()} chars` +
    `${stats.imageCount > 0 ? `, ${stats.imageCount} image block(s)` : ""}).`;

  const text = shortened.trim().length > 0 ? `${prefix}\n\n${shortened}` : prefix;

  return {
    ...message,
    content: [{ type: "text", text }],
  };
}

function truncateMiddle(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars + 1) {
    return text;
  }

  const head = text.slice(0, headChars);
  const tail = text.slice(Math.max(headChars, text.length - tailChars));
  const omitted = Math.max(0, text.length - head.length - tail.length);

  return `${head}\n\n[... ${omitted.toLocaleString()} chars omitted by context-pruner ...]\n\n${tail}`;
}
