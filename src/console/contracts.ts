import { truncateUtf8Prefix } from "../wireValidation";

/**
 * The small, serializable diagnostic contract shared by the Console model
 * and its React presentation.  Sources are deliberately finite for the PoC;
 * this is not a general-purpose logging taxonomy.
 */
export const CONSOLE_LEVELS = ["error", "warn", "info"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const CONSOLE_SOURCES = [
  "scene",
  "renderer",
  "viewport",
  "frontend",
  "timeline",
  "outliner",
  "inspector",
] as const;
export type ConsoleSource = (typeof CONSOLE_SOURCES)[number];

export type ConsoleFilter = "all" | ConsoleLevel;

export interface ConsoleEntry {
  timestamp: string;
  level: ConsoleLevel;
  source: ConsoleSource;
  message: string;
}

export interface ConsoleDiagnostic {
  level: ConsoleLevel;
  source: ConsoleSource;
  message: string;
}

/** Bound untrusted diagnostic payloads before they reach the retained model/UI. */
export const MAX_CONSOLE_MESSAGE_LENGTH = 8_192;

function normalizeConsoleMessage(message: string): string {
  const lineSafeMessage = message.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => (character === "\n" || character === "\r" || character === "\t" ? " " : "�"),
  );
  return lineSafeMessage.length > MAX_CONSOLE_MESSAGE_LENGTH
    ? `${lineSafeMessage.slice(0, MAX_CONSOLE_MESSAGE_LENGTH)}…`
    : lineSafeMessage;
}

export function isConsoleLevel(value: unknown): value is ConsoleLevel {
  return typeof value === "string" && (CONSOLE_LEVELS as readonly string[]).includes(value);
}

export function isConsoleSource(value: unknown): value is ConsoleSource {
  return typeof value === "string" && (CONSOLE_SOURCES as readonly string[]).includes(value);
}

/** Normalize untrusted CustomEvent payloads before they enter the console model. */
export function normalizeConsoleDiagnostic(value: unknown): ConsoleDiagnostic | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const detail = value as Record<string, unknown>;
    if (!isConsoleLevel(detail.level) || typeof detail.message !== "string") return null;
    return {
      level: detail.level,
      source: isConsoleSource(detail.source) ? detail.source : "frontend",
      message: normalizeConsoleMessage(detail.message),
    };
  } catch {
    // CustomEvent payloads can be supplied by an embedding host or extension;
    // a throwing getter must not abort the browser event dispatch.
    return null;
  }
}

/** Convert arbitrary rejection/event details without letting hostile coercion throw. */
export function safeDiagnosticText(value: unknown): string {
  try {
    if (value instanceof Error) {
      return String(value);
    }
    return String(value);
  } catch {
    try {
      if (value instanceof Error) return value.message || value.name || "Unknown error";
    } catch {
      // A hostile Error subclass can throw even while reading its message.
    }
    return "Unknown error";
  }
}

/** Keep command-result text bounded and line-safe before placing it in UI state. */
export function boundedDiagnosticText(value: unknown, maxBytes = 4_096): string {
  const normalized = normalizeConsoleMessage(safeDiagnosticText(value));
  return truncateUtf8Prefix(normalized, maxBytes);
}

export const CONSOLE_LEVEL_RANK: Readonly<Record<ConsoleLevel, number>> = {
  info: 0,
  warn: 1,
  error: 2,
};

export function isConsoleEntryVisible(entry: ConsoleEntry, filter: ConsoleFilter): boolean {
  return filter === "all" || CONSOLE_LEVEL_RANK[entry.level] >= CONSOLE_LEVEL_RANK[filter];
}

export function selectVisibleConsoleEntries(
  entries: readonly ConsoleEntry[],
  filter: ConsoleFilter,
): readonly ConsoleEntry[] {
  if (filter === "all") return entries;
  return entries.filter((entry) => isConsoleEntryVisible(entry, filter));
}

/**
 * Stable, line-oriented representation used by Copy All and diagnostics.
 * Keeping this outside the component also makes clipboard output testable.
 */
export function formatConsoleEntry(entry: ConsoleEntry): string {
  return `${entry.timestamp} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`;
}

export function formatConsoleEntries(entries: readonly ConsoleEntry[]): string {
  return entries.map(formatConsoleEntry).join("\n");
}
