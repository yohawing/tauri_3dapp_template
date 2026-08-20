import { isBoundedUtf8String, isFiniteF32 } from "../wireValidation";

export const SETTINGS_STORAGE_KEY = "tauri3d.settings";
export const SETTINGS_VERSION = 5;
const MAX_SETTINGS_STORAGE_BYTES = 256 * 1024;
const LEGACY_SETTINGS_VERSIONS = [1, 2, 3, 4] as const;

export const UI_SCALES = [0.8, 1, 1.25, 1.5] as const;
export type UiScale = (typeof UI_SCALES)[number];

export const CONSOLE_LEVELS = ["info", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface ViewportEnvironmentSettings {
  enabled: boolean;
  path: string;
  rotationDegrees: number;
  intensity: number;
}

/**
 * Validate a value returned across the Tauri environment-settings boundary.
 * Persisted settings are normalized field-by-field, but an IPC response is
 * accepted atomically so a malformed acknowledgement cannot poison the live
 * viewport state.
 */
export function normalizeViewportEnvironmentSettings(
  value: unknown,
): ViewportEnvironmentSettings | null {
  if (!isRecord(value)) return null;
  const { enabled, path, rotationDegrees, intensity } = value;
  if (
    typeof enabled !== "boolean" ||
    typeof path !== "string" ||
    !isFiniteF32(rotationDegrees) ||
    rotationDegrees < -180 ||
    rotationDegrees > 180 ||
    !isFiniteF32(intensity) ||
    intensity < 0 ||
    intensity > 8
  ) {
    return null;
  }
  return { enabled, path, rotationDegrees, intensity };
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
  ui: {
    scale: UiScale;
  };
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
  ui: {
    scale: 1,
  },
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
    ui: { ...DEFAULT_SETTINGS.ui },
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

export function isUiScale(value: unknown): value is UiScale {
  return typeof value === "number" && (UI_SCALES as readonly number[]).includes(value);
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

  const ui = isRecord(value.ui) ? value.ui : undefined;
  const viewport = isRecord(value.viewport) ? value.viewport : undefined;
  const consoleSettings = isRecord(value.console) ? value.console : undefined;

  if (isUiScale(ui?.scale)) {
    defaults.ui.scale = ui.scale;
  }

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
  if (isBoundedUtf8String(environment?.path, 4_096, true)) {
    defaults.viewport.environment.path = environment.path;
  }
  if (
    isFiniteF32(environment?.rotationDegrees) &&
    environment.rotationDegrees >= -180 &&
    environment.rotationDegrees <= 180
  ) {
    defaults.viewport.environment.rotationDegrees = environment.rotationDegrees;
  }
  if (
    isFiniteF32(environment?.intensity) &&
    environment.intensity >= 0 &&
    environment.intensity <= 8
  ) {
    defaults.viewport.environment.intensity = environment.intensity;
  }
  const lighting = isRecord(viewport?.lighting) ? viewport.lighting : undefined;
  if (isFiniteF32(lighting?.exposure) && lighting.exposure >= 0 && lighting.exposure <= 16) {
    defaults.viewport.lighting.exposure = lighting.exposure;
  }
  if (isTonemap(lighting?.tonemap)) {
    defaults.viewport.lighting.tonemap = lighting.tonemap;
  }
  if (isFiniteF32(lighting?.ambientIntensity) && lighting.ambientIntensity >= 0 && lighting.ambientIntensity <= 4) {
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
  if (isFiniteF32(lighting?.shadowSoftness) && lighting.shadowSoftness >= 0 && lighting.shadowSoftness <= 8) {
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
 * Load and validate the versioned frontend settings. Versions 1 through 4 remain
 * accepted so later additions do not discard existing editor
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
  if (
    serialized.length > MAX_SETTINGS_STORAGE_BYTES ||
    new TextEncoder().encode(serialized).byteLength > MAX_SETTINGS_STORAGE_BYTES
  ) {
    return cloneDefaults();
  }

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
