import { EXTENSION_COMMAND } from "./constants.js";
import type { PrunerProfileName, PrunerState } from "./types.js";

export type PrunerCommandName =
  | "status"
  | "on"
  | "off"
  | "balanced"
  | "aggressive"
  | "context-on"
  | "context-off"
  | "observe-on"
  | "observe-off"
  | "settings"
  | "set"
  | "reset"
  | "help"
  | "";

export interface ParsedCommand {
  name: string;
  rest: string;
}

export type SettableKey =
  | "activate"
  | "deactivate"
  | "keep-recent"
  | "keep-recent-heavy"
  | "heavy-chars"
  | "max-old-chars"
  | "tool-max-chars";

export const COMMAND_OPTIONS: readonly PrunerCommandName[] = [
  "status",
  "on",
  "off",
  "balanced",
  "aggressive",
  "context-on",
  "context-off",
  "observe-on",
  "observe-off",
  "settings",
  "set",
  "reset",
  "help",
];

export const SETTABLE_KEYS: readonly SettableKey[] = [
  "activate",
  "deactivate",
  "keep-recent",
  "keep-recent-heavy",
  "heavy-chars",
  "max-old-chars",
  "tool-max-chars",
];

export function parseSubcommand(raw: string): ParsedCommand {
  const trimmed = raw.trim();
  const spaceIndex = trimmed.indexOf(" ");

  if (spaceIndex === -1) {
    return { name: trimmed.toLowerCase(), rest: "" };
  }

  return {
    name: trimmed.slice(0, spaceIndex).toLowerCase(),
    rest: trimmed.slice(spaceIndex + 1).trim(),
  };
}

export function parseKeyValue(raw: string): { key: string; value: string } {
  const trimmed = raw.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return { key: trimmed.toLowerCase(), value: "" };

  return {
    key: trimmed.slice(0, spaceIndex).toLowerCase(),
    value: trimmed.slice(spaceIndex + 1).trim(),
  };
}

export function buildHelpText(): string {
  return [
    `/${EXTENSION_COMMAND} status`,
    `/${EXTENSION_COMMAND} on`,
    `/${EXTENSION_COMMAND} off`,
    `/${EXTENSION_COMMAND} balanced`,
    `/${EXTENSION_COMMAND} aggressive`,
    `/${EXTENSION_COMMAND} context-on`,
    `/${EXTENSION_COMMAND} context-off`,
    `/${EXTENSION_COMMAND} observe-on`,
    `/${EXTENSION_COMMAND} observe-off`,
    `/${EXTENSION_COMMAND} settings`,
    `/${EXTENSION_COMMAND} set activate <0-1>`,
    `/${EXTENSION_COMMAND} set deactivate <0-1>`,
    `/${EXTENSION_COMMAND} set keep-recent <int>`,
    `/${EXTENSION_COMMAND} set keep-recent-heavy <int>`,
    `/${EXTENSION_COMMAND} set heavy-chars <int>`,
    `/${EXTENSION_COMMAND} set max-old-chars <int>`,
    `/${EXTENSION_COMMAND} set tool-max-chars <int>`,
    `/${EXTENSION_COMMAND} reset`,
    `/${EXTENSION_COMMAND} help`,
  ].join("\n");
}

export function buildStatusText(state: PrunerState): string {
  return `enabled=${state.enabled ? "yes" : "no"}, profile=${state.profile}`;
}

export function isProfileName(name: string): name is PrunerProfileName {
  return name === "balanced" || name === "aggressive";
}

export function isSettableKey(name: string): name is SettableKey {
  return SETTABLE_KEYS.includes(name as SettableKey);
}
