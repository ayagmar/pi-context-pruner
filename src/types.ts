export type PrunerProfileName = "balanced" | "aggressive";

export interface PrunerProfile {
  activateAtContextRatio: number;
  deactivateAtContextRatio: number;
  keepRecentToolResults: number;
  keepRecentHeavyToolResults: number;
  heavyToolResultChars: number;
  maxCharsForOldToolResult: number;
  headChars: number;
  tailChars: number;
  keepErrorsFull: boolean;
  keepToolsFull: readonly string[];
}

export interface PrunerState {
  enabled: boolean;
  profile: PrunerProfileName;
}

export interface ContextUsageSnapshot {
  tokens: number;
  contextWindow: number;
}

export interface ToolResultContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: ToolResultContentPart[];
  [key: string]: unknown;
}

export interface ContextMessage {
  role?: string;
  [key: string]: unknown;
}

export interface PruneResult {
  messages: ContextMessage[];
  changed: number;
}

export type ProfileOverride = Partial<
  Pick<
    PrunerProfile,
    | "activateAtContextRatio"
    | "deactivateAtContextRatio"
    | "keepRecentToolResults"
    | "keepRecentHeavyToolResults"
    | "heavyToolResultChars"
    | "maxCharsForOldToolResult"
  >
>;

export interface PersistedSettings {
  enabled: boolean;
  profile: PrunerProfileName;
  contextPruningEnabled: boolean;
  toolResultMaxChars: number;
  observabilityEnabled: boolean;
  profileOverrides: Partial<Record<PrunerProfileName, ProfileOverride>>;
}
