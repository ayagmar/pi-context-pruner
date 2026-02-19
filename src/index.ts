import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildHelpText,
  buildStatusText,
  COMMAND_OPTIONS,
  isProfileName,
  isSettableKey,
  parseKeyValue,
  parseSubcommand,
} from "./commands.js";
import {
  ACTION_HISTORY_LIMIT,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_PROFILE,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  EXTENSION_COMMAND,
  EXTENSION_NAME,
  PROFILES,
  STATUS_KEY,
  TOOL_RESULT_TRUNCATED_MARKER,
  TOOL_RESULT_TRUNCATE_HEAD_CHARS,
  TOOL_RESULT_TRUNCATE_TAIL_CHARS,
  WIDGET_KEY,
} from "./constants.js";
import { loadPersistedSettings, savePersistedSettings, getConfigPath } from "./persistence.js";
import { pruneContextMessages, shouldPruneForUsage } from "./pruner.js";
import type {
  ContextMessage,
  ContextUsageSnapshot,
  PersistedSettings,
  ProfileOverride,
  PrunerProfile,
  PrunerProfileName,
  PrunerState,
} from "./types.js";

interface ContextEventShape {
  messages: ContextMessage[];
}

interface ToolResultEventShape {
  toolName?: unknown;
  content?: unknown;
  isError?: unknown;
}

interface LooseExtensionApi {
  on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
}

const PROFILE_KEY_ORDER = [
  "activate",
  "deactivate",
  "keep-recent",
  "keep-recent-heavy",
  "heavy-chars",
  "max-old-chars",
] as const;

export default function contextPrunerExtension(pi: ExtensionAPI) {
  let state: PrunerState = {
    enabled: true,
    profile: DEFAULT_PROFILE,
  };

  // Cache-friendly default: stable ingest-time truncation ON, context pruning OFF.
  let contextPruningEnabled = false;
  let pruningActive = false;
  let toolResultMaxChars = DEFAULT_TOOL_RESULT_MAX_CHARS;
  let observabilityEnabled = DEFAULT_OBSERVABILITY_ENABLED;

  const profileOverrides: Partial<Record<PrunerProfileName, ProfileOverride>> = {};
  let actionHistory: string[] = [];

  hydrateFromPersisted(loadPersistedSettings());

  const effectiveProfile = (profileName: PrunerProfileName = state.profile): PrunerProfile => {
    const base = PROFILES[profileName];
    const override = profileOverrides[profileName] ?? {};
    return { ...base, ...override };
  };

  const snapshot = (): PersistedSettings => ({
    enabled: state.enabled,
    profile: state.profile,
    contextPruningEnabled,
    toolResultMaxChars,
    observabilityEnabled,
    profileOverrides,
  });

  const persist = (): void => {
    savePersistedSettings(snapshot());
  };

  const renderStatus = (ctx: Pick<ExtensionContext, "hasUI" | "ui">): void => {
    if (!ctx.hasUI) return;

    const profile = effectiveProfile();
    const contextMode = !state.enabled
      ? "off"
      : contextPruningEnabled
        ? pruningActive
          ? "active"
          : "armed"
        : "off";

    const text =
      `${EXTENSION_NAME}: ${state.enabled ? "on" : "off"}/${state.profile}` +
      ` context=${contextMode}` +
      ` @${Math.round(profile.activateAtContextRatio * 100)}%` +
      ` tool=${toolResultMaxChars}` +
      ` obs=${observabilityEnabled ? "on" : "off"}`;
    ctx.ui.setStatus(STATUS_KEY, text);
  };

  const renderWidget = (ctx: Pick<ExtensionContext, "hasUI" | "ui">): void => {
    if (!ctx.hasUI) return;

    if (!observabilityEnabled || actionHistory.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const lines = ["context-pruner recent actions", ...actionHistory.map((entry) => `• ${entry}`)];

    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
  };

  const recordAction = (ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string): void => {
    if (!observabilityEnabled) {
      return;
    }

    const timestamp = new Date().toISOString().slice(11, 19);
    const entry = `${timestamp} ${message}`;
    actionHistory = [...actionHistory.slice(-(ACTION_HISTORY_LIMIT - 1)), entry];

    if (ctx.hasUI) {
      ctx.ui.notify(`[context-pruner] ${message}`, "info");
      renderWidget(ctx);
    } else {
      console.log(`[context-pruner] ${entry}`);
    }
  };

  const statusDetails = (): string => {
    const profile = effectiveProfile();
    const override = profileOverrides[state.profile];

    return [
      buildStatusText(state),
      `contextPruning=${contextPruningEnabled ? "on" : "off"}`,
      `pruningActive=${pruningActive ? "yes" : "no"}`,
      `activate=${profile.activateAtContextRatio.toFixed(2)}`,
      `deactivate=${profile.deactivateAtContextRatio.toFixed(2)}`,
      `keepRecent=${profile.keepRecentToolResults}`,
      `keepRecentHeavy=${profile.keepRecentHeavyToolResults}`,
      `heavyChars=${profile.heavyToolResultChars}`,
      `maxOldChars=${profile.maxCharsForOldToolResult}`,
      `toolMaxChars=${toolResultMaxChars}`,
      `observability=${observabilityEnabled ? "on" : "off"}`,
      `overrides=${override ? "yes" : "no"}`,
      `config=${getConfigPath()}`,
    ].join(", ");
  };

  const applySetUpdate = (
    rawArgs: string,
    ctx: Pick<ExtensionContext, "hasUI" | "ui">
  ): { ok: true } | { ok: false; error: string } => {
    const update = applySetCommand(effectiveProfile(), rawArgs);
    if (!update.ok) {
      return update;
    }

    if (update.profileOverride) {
      profileOverrides[state.profile] = {
        ...(profileOverrides[state.profile] ?? {}),
        ...update.profileOverride,
      };
      pruningActive = false;
    }

    if (typeof update.toolMaxChars === "number") {
      toolResultMaxChars = update.toolMaxChars;
    }

    persist();
    renderStatus(ctx);
    recordAction(ctx, `settings updated (${state.profile}): ${update.message}`);

    return { ok: true };
  };

  const applyAction = (
    ctx: Pick<ExtensionContext, "hasUI" | "ui">,
    actionMessage: string,
    body: () => void
  ): void => {
    body();
    persist();
    renderStatus(ctx);
    recordAction(ctx, actionMessage);
    notify(ctx, statusDetails());
  };

  const openSettingsUI = async (ctx: Pick<ExtensionContext, "hasUI" | "ui">): Promise<void> => {
    if (!ctx.hasUI) {
      notify(ctx, "Settings UI requires interactive mode.");
      return;
    }

    while (true) {
      const profile = effectiveProfile();
      const choice = await ctx.ui.select("Context Pruner Settings", [
        `Extension enabled: ${state.enabled ? "yes" : "no"}`,
        `Context pruning enabled: ${contextPruningEnabled ? "yes" : "no"}`,
        `Profile: ${state.profile}`,
        `Observability: ${observabilityEnabled ? "on" : "off"}`,
        `Tool result max chars: ${toolResultMaxChars}`,
        `activate: ${profile.activateAtContextRatio.toFixed(2)}`,
        `deactivate: ${profile.deactivateAtContextRatio.toFixed(2)}`,
        `keep-recent: ${profile.keepRecentToolResults}`,
        `keep-recent-heavy: ${profile.keepRecentHeavyToolResults}`,
        `heavy-chars: ${profile.heavyToolResultChars}`,
        `max-old-chars: ${profile.maxCharsForOldToolResult}`,
        "Reset current profile overrides",
        "Close settings",
      ]);

      if (!choice || choice === "Close settings") {
        break;
      }

      if (choice.startsWith("Extension enabled:")) {
        applyAction(
          ctx,
          `extension ${state.enabled ? "disabled" : "enabled"} via settings UI`,
          () => {
            state = { ...state, enabled: !state.enabled };
            if (!state.enabled) pruningActive = false;
          }
        );
        continue;
      }

      if (choice.startsWith("Context pruning enabled:")) {
        applyAction(
          ctx,
          `context pruning ${contextPruningEnabled ? "disabled" : "enabled"} via settings UI`,
          () => {
            contextPruningEnabled = !contextPruningEnabled;
            pruningActive = false;
          }
        );
        continue;
      }

      if (choice.startsWith("Profile:")) {
        const selected = await ctx.ui.select("Choose profile", ["balanced", "aggressive"]);
        if (selected && isProfileName(selected)) {
          applyAction(ctx, `profile switched to ${selected} via settings UI`, () => {
            state = { enabled: true, profile: selected };
            pruningActive = false;
          });
        }
        continue;
      }

      if (choice.startsWith("Observability:")) {
        const next = !observabilityEnabled;

        if (!next) {
          recordAction(ctx, "observability disabled");
        }

        observabilityEnabled = next;
        if (!observabilityEnabled) {
          actionHistory = [];
        }

        persist();
        renderStatus(ctx);
        renderWidget(ctx);
        if (observabilityEnabled) {
          recordAction(ctx, "observability enabled");
        }
        notify(ctx, statusDetails());
        continue;
      }

      if (choice.startsWith("Tool result max chars:")) {
        await promptSetValue(ctx, "tool-max-chars", toolResultMaxChars);
        continue;
      }

      if (choice === "Reset current profile overrides") {
        applyAction(ctx, `reset overrides for ${state.profile} via settings UI`, () => {
          delete profileOverrides[state.profile];
          pruningActive = false;
        });
        continue;
      }

      const matchedProfileKey = PROFILE_KEY_ORDER.find((key) => choice.startsWith(`${key}:`));
      if (matchedProfileKey) {
        const currentValue = profileValueFromKey(profile, matchedProfileKey);
        await promptSetValue(ctx, matchedProfileKey, currentValue);
      }
    }

    notify(ctx, `Settings closed. ${statusDetails()}`);
  };

  const promptSetValue = async (
    ctx: Pick<ExtensionContext, "hasUI" | "ui">,
    key: string,
    currentValue: number
  ): Promise<void> => {
    if (!ctx.hasUI) return;

    const value = await ctx.ui.input(`Set ${key}`, String(currentValue));
    if (!value) return;

    const setResult = applySetUpdate(`${key} ${value}`, ctx);
    if (!setResult.ok) {
      notify(ctx, `${setResult.error}\n${buildHelpText()}`);
      return;
    }

    notify(ctx, statusDetails());
  };

  pi.on("session_start", (_event, ctx) => {
    renderStatus(ctx);
    renderWidget(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    renderStatus(ctx);
    renderWidget(ctx);
  });

  pi.registerCommand(EXTENSION_COMMAND, {
    description:
      "Control cache-safe truncation/context pruning: status | on | off | context-on | context-off | settings | set ...",
    getArgumentCompletions: (prefix) => {
      const safePrefix = prefix.toLowerCase();
      if (safePrefix.startsWith("set ")) {
        const candidates = [
          "set activate",
          "set deactivate",
          "set keep-recent",
          "set keep-recent-heavy",
          "set heavy-chars",
          "set max-old-chars",
          "set tool-max-chars",
        ];
        const matches = candidates.filter((option) => option.startsWith(safePrefix));
        return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
      }

      const matches = COMMAND_OPTIONS.filter((option) => option.startsWith(safePrefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx): Promise<void> => {
      const parsed = parseSubcommand(args);

      switch (parsed.name) {
        case "status":
        case "":
          notify(ctx, statusDetails());
          return;

        case "on":
          applyAction(ctx, "extension enabled", () => {
            state = { ...state, enabled: true };
          });
          return;

        case "off":
          applyAction(ctx, "extension disabled", () => {
            state = { ...state, enabled: false };
            pruningActive = false;
          });
          return;

        case "balanced":
        case "aggressive": {
          const nextProfile: PrunerProfileName = parsed.name;
          applyAction(ctx, `profile switched to ${nextProfile}`, () => {
            state = { enabled: true, profile: nextProfile };
            pruningActive = false;
          });
          return;
        }

        case "context-on":
          applyAction(ctx, "context pruning enabled", () => {
            contextPruningEnabled = true;
            pruningActive = false;
          });
          return;

        case "context-off":
          applyAction(ctx, "context pruning disabled", () => {
            contextPruningEnabled = false;
            pruningActive = false;
          });
          return;

        case "observe-on":
          observabilityEnabled = true;
          persist();
          renderStatus(ctx);
          recordAction(ctx, "observability enabled");
          notify(ctx, statusDetails());
          return;

        case "observe-off":
          recordAction(ctx, "observability disabled");
          observabilityEnabled = false;
          actionHistory = [];
          persist();
          renderStatus(ctx);
          renderWidget(ctx);
          notify(ctx, statusDetails());
          return;

        case "settings":
          await openSettingsUI(ctx);
          return;

        case "reset":
          applyAction(ctx, `reset overrides for ${state.profile}`, () => {
            delete profileOverrides[state.profile];
            toolResultMaxChars = DEFAULT_TOOL_RESULT_MAX_CHARS;
            pruningActive = false;
          });
          return;

        case "set": {
          const setResult = applySetUpdate(parsed.rest, ctx);
          if (!setResult.ok) {
            notify(ctx, `${setResult.error}\n${buildHelpText()}`);
            return;
          }

          notify(ctx, statusDetails());
          return;
        }

        case "help":
          notify(ctx, buildHelpText());
          return;

        default:
          notify(ctx, `${buildHelpText()}\n\nCurrent: ${statusDetails()}`);
      }
    },
  });

  // Codex-style stable truncation at ingest time: one canonical transform per tool result.
  pi.on("tool_result", (event, ctx) => {
    if (!state.enabled) return;
    if (!isToolResultEvent(event)) return;

    const profile = effectiveProfile();
    if (event.isError && profile.keepErrorsFull) return;

    const toolName = normalizeToolName(event.toolName);
    if (profile.keepToolsFull.includes(toolName)) return;

    const extracted = extractTextOnlyContent(event.content);
    if (!extracted) return;

    if (isAlreadyContextPrunerTruncated(extracted.text)) {
      return;
    }

    if (extracted.text.length <= toolResultMaxChars) {
      return;
    }

    const header =
      `${TOOL_RESULT_TRUNCATED_MARKER} ` +
      `tool=${toolName} original_chars=${extracted.text.length} max_chars=${toolResultMaxChars}`;

    const truncatedText = buildTruncatedToolResultText(extracted.text, header, toolResultMaxChars);

    recordAction(
      ctx,
      `tool_result truncated for ${toolName} (${extracted.text.length.toLocaleString()} chars)`
    );

    return {
      content: [{ type: "text", text: truncatedText }],
    };
  });

  registerContextHook(pi, (event, ctx) => {
    if (!state.enabled || !contextPruningEnabled) {
      if (pruningActive) {
        pruningActive = false;
        recordAction(ctx, "context pruning deactivated");
      }
      return;
    }

    if (!isContextEvent(event)) return;

    const profile = effectiveProfile();
    const usage = readUsage(ctx);
    const nextPruningActive = shouldPruneForUsage(usage, profile, pruningActive);

    if (nextPruningActive !== pruningActive) {
      pruningActive = nextPruningActive;
      const usageRatio =
        usage && usage.contextWindow > 0 ? usage.tokens / usage.contextWindow : undefined;
      const ratioText = usageRatio ? `${(usageRatio * 100).toFixed(1)}%` : "unknown usage";

      recordAction(
        ctx,
        `context pruning ${pruningActive ? "activated" : "deactivated"} (${ratioText})`
      );
    } else {
      pruningActive = nextPruningActive;
    }

    if (!pruningActive) {
      return;
    }

    const result = pruneContextMessages(event.messages, { profile });

    if (result.changed > 0) {
      recordAction(ctx, `context payload pruned (${result.changed} tool result message(s) shrunk)`);
      return { messages: result.messages };
    }

    return;
  });

  function hydrateFromPersisted(raw: Partial<PersistedSettings> | undefined): void {
    if (!raw) return;

    if (typeof raw.enabled === "boolean") {
      state = { ...state, enabled: raw.enabled };
    }

    const persistedProfile = raw.profile;
    if (typeof persistedProfile === "string" && isProfileName(persistedProfile)) {
      state = { ...state, profile: persistedProfile };
    }

    if (typeof raw.contextPruningEnabled === "boolean") {
      contextPruningEnabled = raw.contextPruningEnabled;
    }

    if (
      typeof raw.toolResultMaxChars === "number" &&
      Number.isFinite(raw.toolResultMaxChars) &&
      raw.toolResultMaxChars >= 500
    ) {
      toolResultMaxChars = Math.floor(raw.toolResultMaxChars);
    }

    if (typeof raw.observabilityEnabled === "boolean") {
      observabilityEnabled = raw.observabilityEnabled;
    }

    if (raw.profileOverrides && typeof raw.profileOverrides === "object") {
      for (const profileName of ["balanced", "aggressive"] as const) {
        const parsed = sanitizeProfileOverride(raw.profileOverrides[profileName], profileName);
        if (parsed) {
          profileOverrides[profileName] = parsed;
        }
      }
    }
  }
}

function applySetCommand(
  profile: PrunerProfile,
  rawArgs: string
):
  | { ok: true; profileOverride?: ProfileOverride; toolMaxChars?: number; message: string }
  | { ok: false; error: string } {
  const { key, value } = parseKeyValue(rawArgs);

  if (!isSettableKey(key)) {
    return { ok: false, error: `Unknown key: ${key || "(empty)"}` };
  }

  const num = Number(value);
  if (!Number.isFinite(num)) {
    return { ok: false, error: `Invalid number: ${value || "(empty)"}` };
  }

  if (key === "tool-max-chars") {
    const intNum = Math.floor(num);
    if (intNum < 500) {
      return { ok: false, error: "tool-max-chars must be >= 500" };
    }
    return { ok: true, toolMaxChars: intNum, message: `${key}=${intNum}` };
  }

  const candidate: PrunerProfile = { ...profile };
  const override: ProfileOverride = {};
  let message = "";

  switch (key) {
    case "activate":
      if (num <= 0 || num >= 1) return { ok: false, error: "activate must be > 0 and < 1" };
      candidate.activateAtContextRatio = num;
      override.activateAtContextRatio = num;
      message = `${key}=${num.toFixed(2)}`;
      break;

    case "deactivate":
      if (num < 0 || num >= 1) return { ok: false, error: "deactivate must be >= 0 and < 1" };
      candidate.deactivateAtContextRatio = num;
      override.deactivateAtContextRatio = num;
      message = `${key}=${num.toFixed(2)}`;
      break;

    case "keep-recent": {
      const intNum = Math.floor(num);
      if (intNum < 0) return { ok: false, error: "keep-recent must be >= 0" };
      candidate.keepRecentToolResults = intNum;
      override.keepRecentToolResults = intNum;
      message = `${key}=${intNum}`;
      break;
    }

    case "keep-recent-heavy": {
      const intNum = Math.floor(num);
      if (intNum < 0) return { ok: false, error: "keep-recent-heavy must be >= 0" };
      candidate.keepRecentHeavyToolResults = intNum;
      override.keepRecentHeavyToolResults = intNum;
      message = `${key}=${intNum}`;
      break;
    }

    case "heavy-chars": {
      const intNum = Math.floor(num);
      if (intNum < 100) return { ok: false, error: "heavy-chars must be >= 100" };
      candidate.heavyToolResultChars = intNum;
      override.heavyToolResultChars = intNum;
      message = `${key}=${intNum}`;
      break;
    }

    case "max-old-chars": {
      const intNum = Math.floor(num);
      if (intNum < 100) return { ok: false, error: "max-old-chars must be >= 100" };
      candidate.maxCharsForOldToolResult = intNum;
      override.maxCharsForOldToolResult = intNum;
      message = `${key}=${intNum}`;
      break;
    }
  }

  if (candidate.deactivateAtContextRatio >= candidate.activateAtContextRatio) {
    return {
      ok: false,
      error: "deactivate must be lower than activate to keep hysteresis stable",
    };
  }

  return { ok: true, profileOverride: override, message };
}

function sanitizeProfileOverride(
  value: unknown,
  profileName: PrunerProfileName
): ProfileOverride | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const parsed: ProfileOverride = {};

  if (
    typeof raw.activateAtContextRatio === "number" &&
    Number.isFinite(raw.activateAtContextRatio) &&
    raw.activateAtContextRatio > 0 &&
    raw.activateAtContextRatio < 1
  ) {
    parsed.activateAtContextRatio = raw.activateAtContextRatio;
  }

  if (
    typeof raw.deactivateAtContextRatio === "number" &&
    Number.isFinite(raw.deactivateAtContextRatio) &&
    raw.deactivateAtContextRatio >= 0 &&
    raw.deactivateAtContextRatio < 1
  ) {
    parsed.deactivateAtContextRatio = raw.deactivateAtContextRatio;
  }

  if (
    typeof raw.keepRecentToolResults === "number" &&
    Number.isFinite(raw.keepRecentToolResults) &&
    raw.keepRecentToolResults >= 0
  ) {
    parsed.keepRecentToolResults = Math.floor(raw.keepRecentToolResults);
  }

  if (
    typeof raw.keepRecentHeavyToolResults === "number" &&
    Number.isFinite(raw.keepRecentHeavyToolResults) &&
    raw.keepRecentHeavyToolResults >= 0
  ) {
    parsed.keepRecentHeavyToolResults = Math.floor(raw.keepRecentHeavyToolResults);
  }

  if (
    typeof raw.heavyToolResultChars === "number" &&
    Number.isFinite(raw.heavyToolResultChars) &&
    raw.heavyToolResultChars >= 100
  ) {
    parsed.heavyToolResultChars = Math.floor(raw.heavyToolResultChars);
  }

  if (
    typeof raw.maxCharsForOldToolResult === "number" &&
    Number.isFinite(raw.maxCharsForOldToolResult) &&
    raw.maxCharsForOldToolResult >= 100
  ) {
    parsed.maxCharsForOldToolResult = Math.floor(raw.maxCharsForOldToolResult);
  }

  const baseProfile = PROFILES[profileName];
  const mergedActivate = parsed.activateAtContextRatio ?? baseProfile.activateAtContextRatio;
  const mergedDeactivate = parsed.deactivateAtContextRatio ?? baseProfile.deactivateAtContextRatio;

  if (mergedDeactivate >= mergedActivate) {
    delete parsed.activateAtContextRatio;
    delete parsed.deactivateAtContextRatio;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function profileValueFromKey(
  profile: PrunerProfile,
  key: (typeof PROFILE_KEY_ORDER)[number]
): number {
  switch (key) {
    case "activate":
      return profile.activateAtContextRatio;
    case "deactivate":
      return profile.deactivateAtContextRatio;
    case "keep-recent":
      return profile.keepRecentToolResults;
    case "keep-recent-heavy":
      return profile.keepRecentHeavyToolResults;
    case "heavy-chars":
      return profile.heavyToolResultChars;
    case "max-old-chars":
      return profile.maxCharsForOldToolResult;
  }
}

function isToolResultEvent(event: unknown): event is ToolResultEventShape {
  return Boolean(event) && typeof event === "object" && "content" in (event as object);
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : "tool";
}

function extractTextOnlyContent(content: unknown): { text: string } | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return undefined;

    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type !== "text") {
      // Keep non-text tool results untouched (e.g. image attachments).
      return undefined;
    }
    textParts.push(typeof typed.text === "string" ? typed.text : "");
  }

  return { text: textParts.join("\n") };
}

function isAlreadyContextPrunerTruncated(text: string): boolean {
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  return firstLine.startsWith(TOOL_RESULT_TRUNCATED_MARKER);
}

function buildTruncatedToolResultText(text: string, header: string, maxChars: number): string {
  if (maxChars <= 0) return "";

  const separator = "\n\n";
  const availableTextBudget = Math.max(0, maxChars - header.length - separator.length);

  if (availableTextBudget <= 0) {
    return header.slice(0, maxChars);
  }

  const headChars = Math.max(
    1,
    Math.min(TOOL_RESULT_TRUNCATE_HEAD_CHARS, Math.floor(availableTextBudget * 0.7))
  );
  const tailChars = Math.max(
    0,
    Math.min(TOOL_RESULT_TRUNCATE_TAIL_CHARS, availableTextBudget - headChars)
  );

  const rawBody = truncateMiddleStable(text, headChars, tailChars);
  const body = clampTextToMaxChars(rawBody, availableTextBudget);

  return `${header}${separator}${body}`;
}

function clampTextToMaxChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);

  const marker = "...";
  const available = maxChars - marker.length;
  const head = Math.max(1, Math.floor(available * 0.7));
  const tail = Math.max(0, available - head);

  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

function truncateMiddleStable(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars + 1) {
    return text;
  }

  const head = text.slice(0, headChars);
  const tail = text.slice(Math.max(headChars, text.length - tailChars));
  const omitted = Math.max(0, text.length - head.length - tail.length);

  return `${head}\n\n[... ${omitted.toLocaleString()} chars omitted by context-pruner ...]\n\n${tail}`;
}

function registerContextHook(
  pi: ExtensionAPI,
  handler: (event: unknown, ctx: ExtensionContext) => { messages: ContextMessage[] } | undefined
): void {
  const looseApi = pi as unknown as LooseExtensionApi;
  looseApi.on("context", handler);
}

function notify(
  ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info") => void } },
  message: string
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "info");
  } else {
    console.log(message);
  }
}

function isContextEvent(event: unknown): event is ContextEventShape {
  return (
    Boolean(event) &&
    typeof event === "object" &&
    Array.isArray((event as { messages?: unknown }).messages)
  );
}

function readUsage(
  ctx: Pick<ExtensionContext, "getContextUsage">
): ContextUsageSnapshot | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}
