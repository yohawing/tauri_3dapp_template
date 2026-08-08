export const SETTINGS_STORAGE_KEY = "tauri3d.settings";
export const SETTINGS_VERSION = 1;

export const CONSOLE_LEVELS = ["info", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface Settings {
  viewport: {
    debugOverlay: boolean;
  };
  console: {
    minimumLevel: ConsoleLevel;
    autoScroll: boolean;
  };
}

/**
 * The initial values intentionally describe behavior that is already visible
 * in the PoC: viewport diagnostics are on, while the console starts at info
 * and follows new entries.
 */
export const DEFAULT_SETTINGS: Settings = {
  viewport: {
    debugOverlay: true,
  },
  console: {
    minimumLevel: "info",
    autoScroll: true,
  },
};

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function cloneDefaults(): Settings {
  return {
    viewport: { ...DEFAULT_SETTINGS.viewport },
    console: { ...DEFAULT_SETTINGS.console },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsoleLevel(value: unknown): value is ConsoleLevel {
  return typeof value === "string" && (CONSOLE_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalize a settings object without trusting values from a persisted file.
 * Unknown keys are ignored and each known key independently falls back to its
 * default when missing or malformed.
 */
export function normalizeSettings(value: unknown): Settings {
  const defaults = cloneDefaults();
  if (!isRecord(value)) return defaults;

  const viewport = isRecord(value.viewport) ? value.viewport : undefined;
  const consoleSettings = isRecord(value.console) ? value.console : undefined;

  if (typeof viewport?.debugOverlay === "boolean") {
    defaults.viewport.debugOverlay = viewport.debugOverlay;
  }
  if (isConsoleLevel(consoleSettings?.minimumLevel)) {
    defaults.console.minimumLevel = consoleSettings.minimumLevel;
  }
  if (typeof consoleSettings?.autoScroll === "boolean") {
    defaults.console.autoScroll = consoleSettings.autoScroll;
  }

  return defaults;
}

function resolveStorage(storage: SettingsStorage | null | undefined): SettingsStorage | undefined {
  if (storage !== undefined) return storage ?? undefined;
  if (typeof window === "undefined") return undefined;

  try {
    return window.localStorage;
  } catch {
    // Access to localStorage can be denied by the embedding WebView or by
    // browser privacy settings. Settings remain usable for this session.
    return undefined;
  }
}

/**
 * Load and validate the v1 frontend settings. A missing store, malformed JSON,
 * unknown version, or storage exception is treated as an empty store.
 */
export function loadSettings(storage?: SettingsStorage | null): Settings {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return cloneDefaults();

  let serialized: string | null;
  try {
    serialized = resolvedStorage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return cloneDefaults();
  }
  if (serialized === null) return cloneDefaults();

  try {
    const payload: unknown = JSON.parse(serialized);
    if (!isRecord(payload) || payload.version !== SETTINGS_VERSION || !isRecord(payload.settings)) {
      return cloneDefaults();
    }
    return normalizeSettings(payload.settings);
  } catch {
    return cloneDefaults();
  }
}

/**
 * Persist normalized settings in a versioned envelope. The return value only
 * reports whether the storage write was accepted; callers can continue with
 * the in-memory settings when persistence is unavailable.
 */
export function saveSettings(settings: Settings, storage?: SettingsStorage | null): boolean {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return false;

  const payload = {
    version: SETTINGS_VERSION,
    settings: normalizeSettings(settings),
  };
  try {
    resolvedStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
