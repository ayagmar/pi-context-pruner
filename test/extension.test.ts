import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import contextPrunerExtension from "../src/index.js";
import { EXTENSION_COMMAND, TOOL_RESULT_TRUNCATED_MARKER } from "../src/constants.js";
import { CONFIG_PATH_ENV } from "../src/persistence.js";

interface RegisteredCommand {
  handler: (args: string, ctx: MockContext) => Promise<void>;
}

interface Harness {
  pi: ExtensionAPI;
  eventHandlers: Map<string, ((event: unknown, ctx: MockContext) => unknown)[]>;
  commands: Map<string, RegisteredCommand>;
}

interface MockContext {
  hasUI: boolean;
  notifications: string[];
  statuses: string[];
  widgets: string[][];
  usage: { tokens: number; contextWindow: number } | undefined;
  ui: {
    notify: (message: string, level: "info") => void;
    setStatus: (key: string, value: string) => void;
    setWidget: (
      key: string,
      value: string[] | undefined,
      options?: { placement?: "belowEditor" | "aboveEditor" }
    ) => void;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
  getContextUsage: () => { tokens: number; contextWindow: number } | undefined;
}

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "pi-context-pruner-test-"));
const CONFIG_PATH = join(CONFIG_DIR, "settings.json");
const ORIGINAL_CONFIG_PATH_ENV = process.env[CONFIG_PATH_ENV];
const SERIAL = { concurrency: false } as const;
process.env[CONFIG_PATH_ENV] = CONFIG_PATH;

after(() => {
  if (ORIGINAL_CONFIG_PATH_ENV === undefined) {
    delete process.env[CONFIG_PATH_ENV];
  } else {
    process.env[CONFIG_PATH_ENV] = ORIGINAL_CONFIG_PATH_ENV;
  }

  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

void test("extension registers command + context + tool_result hooks", SERIAL, () => {
  cleanupConfig();

  const harness = createHarness();
  contextPrunerExtension(harness.pi);

  assert.ok(harness.commands.has(EXTENSION_COMMAND));
  assert.ok(harness.eventHandlers.has("context"));
  assert.ok(harness.eventHandlers.has("tool_result"));
});

void test("tool_result truncates long output in stable ingest-time mode", SERIAL, () => {
  cleanupConfig();

  const harness = createHarness();
  contextPrunerExtension(harness.pi);

  const toolResultHandler = harness.eventHandlers.get("tool_result")?.[0];
  assert.ok(toolResultHandler);

  const event = {
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "x".repeat(15_000) }],
  };

  const ctx = createContext(undefined);
  const result = toolResultHandler?.(event, ctx) as
    | { content?: { type?: string; text?: string }[] }
    | undefined;

  assert.ok(result);
  const text = result?.content?.[0]?.text ?? "";
  assert.match(text, new RegExp(TOOL_RESULT_TRUNCATED_MARKER.replace(/[\[\]]/g, "\\$&")));
  assert.ok(ctx.notifications.some((message) => message.includes("tool_result truncated")));
  assert.ok(ctx.widgets.length > 0);
});

void test("context pruning is off by default", SERIAL, () => {
  cleanupConfig();

  const harness = createHarness();
  contextPrunerExtension(harness.pi);

  const contextHandler = harness.eventHandlers.get("context")?.[0];
  assert.ok(contextHandler);

  const event = {
    messages: Array.from({ length: 12 }, (_, index) => ({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: `${index}:${"x".repeat(7000)}` }],
    })),
  };

  const result = contextHandler?.(event, createContext({ tokens: 95, contextWindow: 100 }));
  assert.equal(result, undefined);
});

void test(
  "context-on enables threshold-based context pruning and logs action",
  SERIAL,
  async () => {
    cleanupConfig();

    const harness = createHarness();
    contextPrunerExtension(harness.pi);

    const command = harness.commands.get(EXTENSION_COMMAND);
    const contextHandler = harness.eventHandlers.get("context")?.[0];

    assert.ok(command);
    assert.ok(contextHandler);

    const ctx = createContext({ tokens: 95, contextWindow: 100 });
    await command?.handler("context-on", ctx);

    const event = {
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: `${index}:${"x".repeat(7000)}` }],
      })),
    };

    const result = contextHandler?.(event, ctx) as { messages?: unknown[] } | undefined;
    assert.ok(result);
    const firstText = getText(result?.messages?.[0]);
    assert.match(firstText, /\[context-pruner\] Older bash result trimmed/);
    assert.ok(ctx.notifications.some((message) => message.includes("context payload pruned")));
  }
);

void test("set tool-max-chars updates truncation limit", SERIAL, async () => {
  cleanupConfig();

  const harness = createHarness();
  contextPrunerExtension(harness.pi);

  const command = harness.commands.get(EXTENSION_COMMAND);
  const toolResultHandler = harness.eventHandlers.get("tool_result")?.[0];
  assert.ok(command);
  assert.ok(toolResultHandler);

  const ctx = createContext(undefined);
  await command?.handler("set tool-max-chars 20000", ctx);

  const event = {
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "x".repeat(15_000) }],
  };

  const result = toolResultHandler?.(event, ctx);
  assert.equal(result, undefined);
});

void test("set keep-recent stores normalized integer value", SERIAL, async () => {
  cleanupConfig();

  const harness = createHarness();
  contextPrunerExtension(harness.pi);

  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(command);

  const ctx = createContext(undefined);
  await command?.handler("set keep-recent 3.9", ctx);
  await command?.handler("status", ctx);

  const status = ctx.notifications.at(-1) ?? "";
  assert.match(status, /keepRecent=3/);
});

void test("unknown command does not implicitly switch profile", SERIAL, async () => {
  cleanupConfig();

  const harness = createHarness();
  contextPrunerExtension(harness.pi);

  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(command);

  const ctx = createContext(undefined);
  await command?.handler("aggressive", ctx);
  await command?.handler("not-a-command balanced", ctx);
  await command?.handler("status", ctx);

  const status = ctx.notifications.at(-1) ?? "";
  assert.match(status, /profile=aggressive/);
});

void test("settings persist across extension instances", SERIAL, async () => {
  cleanupConfig();

  const firstHarness = createHarness();
  contextPrunerExtension(firstHarness.pi);
  const firstCommand = firstHarness.commands.get(EXTENSION_COMMAND);
  assert.ok(firstCommand);

  const firstCtx = createContext(undefined);
  await firstCommand?.handler("context-on", firstCtx);
  await firstCommand?.handler("set tool-max-chars 22222", firstCtx);

  const secondHarness = createHarness();
  contextPrunerExtension(secondHarness.pi);
  const secondCommand = secondHarness.commands.get(EXTENSION_COMMAND);
  assert.ok(secondCommand);

  const secondCtx = createContext(undefined);
  await secondCommand?.handler("status", secondCtx);

  const status = secondCtx.notifications.at(-1) ?? "";
  assert.match(status, /contextPruning=on/);
  assert.match(status, /toolMaxChars=22222/);
});

void test(
  "invalid persisted hysteresis override is ignored while other overrides are kept",
  SERIAL,
  async () => {
    cleanupConfig();

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          profileOverrides: {
            balanced: {
              activateAtContextRatio: 0.6,
              heavyToolResultChars: 4321,
            },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const harness = createHarness();
    contextPrunerExtension(harness.pi);
    const command = harness.commands.get(EXTENSION_COMMAND);
    assert.ok(command);

    const ctx = createContext(undefined);
    await command?.handler("status", ctx);

    const status = ctx.notifications.at(-1) ?? "";
    assert.match(status, /activate=0.80/);
    assert.match(status, /deactivate=0.70/);
    assert.match(status, /heavyChars=4321/);
  }
);

function createHarness(): Harness {
  const eventHandlers = new Map<string, ((event: unknown, ctx: MockContext) => unknown)[]>();
  const commands = new Map<string, RegisteredCommand>();

  const pi = {
    on: (eventName: string, handler: (event: unknown, ctx: MockContext) => unknown) => {
      const list = eventHandlers.get(eventName) ?? [];
      list.push(handler);
      eventHandlers.set(eventName, list);
    },
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  return { pi, eventHandlers, commands };
}

function createContext(usage: { tokens: number; contextWindow: number } | undefined): MockContext {
  const notifications: string[] = [];
  const statuses: string[] = [];
  const widgets: string[][] = [];

  return {
    hasUI: true,
    notifications,
    statuses,
    widgets,
    usage,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: (key: string, value: string) => {
        statuses.push(`${key}:${value}`);
      },
      setWidget: (
        _key: string,
        value: string[] | undefined,
        _options?: { placement?: "belowEditor" | "aboveEditor" }
      ) => {
        if (value) widgets.push(value);
      },
      select: (_title: string, options: string[]) => Promise.resolve(options[0]),
      input: (_title: string, placeholder?: string) => Promise.resolve(placeholder),
    },
    getContextUsage: function () {
      return this.usage;
    },
  };
}

function getText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0] as { type?: unknown; text?: unknown };
  return first.type === "text" && typeof first.text === "string" ? first.text : "";
}

function cleanupConfig(): void {
  rmSync(CONFIG_PATH, { force: true });
}
