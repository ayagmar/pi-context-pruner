import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PersistedSettings } from "./types.js";

export const CONFIG_PATH_ENV = "PI_CONTEXT_PRUNER_CONFIG_PATH";

export function getConfigPath(): string {
  const fromEnv = process.env[CONFIG_PATH_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return join(homedir(), ".pi", "agent", "state", "pi-context-pruner.json");
}

export function loadPersistedSettings(): Partial<PersistedSettings> | undefined {
  const path = getConfigPath();

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    return parsed as Partial<PersistedSettings>;
  } catch {
    return undefined;
  }
}

export function savePersistedSettings(settings: PersistedSettings): void {
  const path = getConfigPath();

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[context-pruner] failed to save settings: ${message}`);
  }
}
