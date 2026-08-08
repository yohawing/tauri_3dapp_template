/**
 * The small, serializable diagnostic contract shared by the Console model
 * and its React presentation.  Sources are deliberately finite for the PoC;
 * this is not a general-purpose logging taxonomy.
 */
export const CONSOLE_LEVELS = ["error", "warn", "info"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const CONSOLE_SOURCES = ["scene", "renderer", "viewport", "frontend"] as const;
export type ConsoleSource = (typeof CONSOLE_SOURCES)[number];

export type ConsoleFilter = "all" | ConsoleLevel;

export interface ConsoleEntry {
  timestamp: string;
  level: ConsoleLevel;
  source: ConsoleSource;
  message: string;
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
