export const SETTINGS_STORAGE_KEY = "tauri3d.settings";
export const SETTINGS_VERSION = 4;
const LEGACY_SETTINGS_VERSIONS = [1, 2, 3] as const;

export const CONSOLE_LEVELS = ["info", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface ViewportEnvironmentSettings {
  enabled: boolean;
  path: string;
  rotationDegrees: number;
  intensity: number;
}

export type ViewportTonemap = "none" | "reinhard" | "aces";
export type ViewportBackgroundMode = "transparent" | "solid";

export interface ViewportLightingSettings {
  exposure: number;
  tonemap: ViewportTonemap;
  ambientIntensity: number;
  ambientColor: string;
  shadowsEnabled: boolean;
  shadowResolution: 512 | 1024 | 2048;
  shadowSoftness: number;
  backgroundMode: ViewportBackgroundMode;
  backgroundColor: string;
}

export interface Settings {
  viewport: {
    debugOverlay: boolean;
    displayMode: "lit" | "wireframe";
    showGrid: boolean;
    showBones: boolean;
    projection: "perspective" | "orthographic";
    fov: 30 | 45 | 60 | 90;
    environment: ViewportEnvironmentSettings;
    lighting: ViewportLightingSettings;
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
    debugOverlay: false,
    displayMode: "lit",
    showGrid: true,
    showBones: false,
    projection: "perspective",
    fov: 45,
    environment: {
      enabled: false,
      path: "",
      rotationDegrees: 0,
      intensity: 1,
    },
    lighting: {
      exposure: 1,
      tonemap: "none",
      ambientIntensity: 0.2,
      ambientColor: "#ffffff",
      shadowsEnabled: true,
      shadowResolution: 2048,
      shadowSoftness: 1,
      backgroundMode: "transparent",
      backgroundColor: "#000000",
    },
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
    viewport: {
      ...DEFAULT_SETTINGS.viewport,
      environment: { ...DEFAULT_SETTINGS.viewport.environment },
      lighting: { ...DEFAULT_SETTINGS.viewport.lighting },
    },
    console: { ...DEFAULT_SETTINGS.console },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsoleLevel(value: unknown): value is ConsoleLevel {
  return typeof value === "string" && (CONSOLE_LEVELS as readonly string[]).includes(value);
}

function isProjection(value: unknown): value is Settings["viewport"]["projection"] {
  return value === "perspective" || value === "orthographic";
}

function isFov(value: unknown): value is Settings["viewport"]["fov"] {
  return value === 30 || value === 45 || value === 60 || value === 90;
}

function isTonemap(value: unknown): value is ViewportTonemap {
  return value === "none" || value === "reinhard" || value === "aces";
}

function isBackgroundMode(value: unknown): value is ViewportBackgroundMode {
  return value === "transparent" || value === "solid";
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isShadowResolution(value: unknown): value is Settings["viewport"]["lighting"]["shadowResolution"] {
  return value === 512 || value === 1024 || value === 2048;
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
  if (viewport?.displayMode === "lit" || viewport?.displayMode === "wireframe") {
    defaults.viewport.displayMode = viewport.displayMode;
  }
  if (typeof viewport?.showGrid === "boolean") {
    defaults.viewport.showGrid = viewport.showGrid;
  }
  if (typeof viewport?.showBones === "boolean") {
    defaults.viewport.showBones = viewport.showBones;
  }
  if (isProjection(viewport?.projection)) {
    defaults.viewport.projection = viewport.projection;
  }
  if (isFov(viewport?.fov)) {
    defaults.viewport.fov = viewport.fov;
  }
  const environment = isRecord(viewport?.environment) ? viewport.environment : undefined;
  if (typeof environment?.enabled === "boolean") {
    defaults.viewport.environment.enabled = environment.enabled;
  }
  if (typeof environment?.path === "string") {
    defaults.viewport.environment.path = environment.path;
  }
  if (
    typeof environment?.rotationDegrees === "number" &&
    Number.isFinite(environment.rotationDegrees) &&
    environment.rotationDegrees >= -180 &&
    environment.rotationDegrees <= 180
  ) {
    defaults.viewport.environment.rotationDegrees = environment.rotationDegrees;
  }
  if (
    typeof environment?.intensity === "number" &&
    Number.isFinite(environment.intensity) &&
    environment.intensity >= 0 &&
    environment.intensity <= 8
  ) {
    defaults.viewport.environment.intensity = environment.intensity;
  }
  const lighting = isRecord(viewport?.lighting) ? viewport.lighting : undefined;
  if (typeof lighting?.exposure === "number" && Number.isFinite(lighting.exposure) && lighting.exposure >= 0 && lighting.exposure <= 16) {
    defaults.viewport.lighting.exposure = lighting.exposure;
  }
  if (isTonemap(lighting?.tonemap)) {
    defaults.viewport.lighting.tonemap = lighting.tonemap;
  }
  if (typeof lighting?.ambientIntensity === "number" && Number.isFinite(lighting.ambientIntensity) && lighting.ambientIntensity >= 0 && lighting.ambientIntensity <= 4) {
    defaults.viewport.lighting.ambientIntensity = lighting.ambientIntensity;
  }
  if (isHexColor(lighting?.ambientColor)) {
    defaults.viewport.lighting.ambientColor = lighting.ambientColor.toLowerCase();
  }
  if (typeof lighting?.shadowsEnabled === "boolean") {
    defaults.viewport.lighting.shadowsEnabled = lighting.shadowsEnabled;
  }
  if (isShadowResolution(lighting?.shadowResolution)) {
    defaults.viewport.lighting.shadowResolution = lighting.shadowResolution;
  }
  if (typeof lighting?.shadowSoftness === "number" && Number.isFinite(lighting.shadowSoftness) && lighting.shadowSoftness >= 0 && lighting.shadowSoftness <= 8) {
    defaults.viewport.lighting.shadowSoftness = lighting.shadowSoftness;
  }
  if (isBackgroundMode(lighting?.backgroundMode)) {
    defaults.viewport.lighting.backgroundMode = lighting.backgroundMode;
  }
  if (isHexColor(lighting?.backgroundColor)) {
    defaults.viewport.lighting.backgroundColor = lighting.backgroundColor.toLowerCase();
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
 * Load and validate the versioned frontend settings. Versions 1 through 3 remain
 * accepted so lighting additions do not discard existing editor
 * preferences; fields absent from an older payload use their defaults.
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
    if (
      !isRecord(payload) ||
      (payload.version !== SETTINGS_VERSION &&
        !(LEGACY_SETTINGS_VERSIONS as readonly number[]).includes(payload.version as number)) ||
      !isRecord(payload.settings)
    ) {
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
