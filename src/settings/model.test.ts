import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  loadSettings,
  normalizeViewportEnvironmentSettings,
  saveSettings,
} from "./model";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("settings persistence", () => {
  it("accepts only finite, bounded environment IPC responses", () => {
    const value = {
      enabled: true,
      path: "C:\\assets\\studio.hdr",
      rotationDegrees: -90,
      intensity: 2,
    };
    expect(normalizeViewportEnvironmentSettings(value)).toEqual(value);
    expect(normalizeViewportEnvironmentSettings({ ...value, intensity: Number.NaN })).toBeNull();
    expect(normalizeViewportEnvironmentSettings({ ...value, intensity: Number.MAX_VALUE })).toBeNull();
    expect(normalizeViewportEnvironmentSettings({ ...value, rotationDegrees: Number.MAX_VALUE })).toBeNull();
    expect(normalizeViewportEnvironmentSettings({ ...value, rotationDegrees: 181 })).toBeNull();
    expect(normalizeViewportEnvironmentSettings({ ...value, enabled: "yes" })).toBeNull();
    expect(normalizeViewportEnvironmentSettings({ ...value, path: null })).toBeNull();
  });

  it("returns independent defaults when no persisted value exists", () => {
    const first = loadSettings(null);
    first.viewport.debugOverlay = true;

    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(first).not.toBe(DEFAULT_SETTINGS);
  });

  it("restores a saved v5 payload", () => {
    const storage = new MemoryStorage();
    const settings = {
      ui: { scale: 1.25 as const },
      viewport: {
        debugOverlay: false,
        displayMode: "wireframe" as const,
        showGrid: false,
        showBones: true,
        projection: "orthographic" as const,
        fov: 60 as const,
        environment: {
          enabled: true,
          path: "F:\\assets\\studio.hdr",
          rotationDegrees: 90,
          intensity: 1.5,
        },
        lighting: {
          exposure: 1.25,
          tonemap: "reinhard" as const,
          ambientIntensity: 0.35,
          ambientColor: "#aabbcc",
          shadowsEnabled: true,
          shadowResolution: 1024 as const,
          shadowSoftness: 2,
          backgroundMode: "solid" as const,
          backgroundColor: "#101820",
        },
      },
      console: { minimumLevel: "warn" as const, autoScroll: false },
    };

    expect(saveSettings(settings, storage)).toBe(true);
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? "")).toEqual({
      version: SETTINGS_VERSION,
      settings,
    });
    expect(loadSettings(storage)).toEqual(settings);
  });

  it("falls back for malformed JSON and unknown versions", () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, "not-json");
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);

    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION + 1,
        settings: { viewport: { debugOverlay: false } },
      }),
    );
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("normalizes malformed values independently to their defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: {
          viewport: { debugOverlay: false },
          console: { minimumLevel: "verbose", autoScroll: "yes" },
        },
      }),
    );

    expect(loadSettings(storage)).toEqual({
      ui: DEFAULT_SETTINGS.ui,
      viewport: { ...DEFAULT_SETTINGS.viewport, debugOverlay: false },
      console: {
        minimumLevel: DEFAULT_SETTINGS.console.minimumLevel,
        autoScroll: DEFAULT_SETTINGS.console.autoScroll,
      },
    });
  });

  it("keeps new viewport flags backward-compatible with an older v1 payload", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        settings: {
          viewport: { debugOverlay: true },
          console: { minimumLevel: "info", autoScroll: true },
        },
      }),
    );

    expect(loadSettings(storage)).toEqual({
      ...DEFAULT_SETTINGS,
      viewport: { ...DEFAULT_SETTINGS.viewport, debugOverlay: true },
    });
  });

  it("accepts v1 camera-less settings and applies camera defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        settings: {
          viewport: { displayMode: "lit", showGrid: true, showBones: false },
          console: { minimumLevel: "info", autoScroll: true },
        },
      }),
    );

    expect(loadSettings(storage).viewport.projection).toBe(DEFAULT_SETTINGS.viewport.projection);
    expect(loadSettings(storage).viewport.fov).toBe(DEFAULT_SETTINGS.viewport.fov);
  });

  it("accepts v2 environment-less settings and applies environment defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        settings: {
          viewport: {
            displayMode: "lit",
            showGrid: true,
            showBones: false,
            projection: "perspective",
            fov: 45,
          },
          console: { minimumLevel: "info", autoScroll: true },
        },
      }),
    );

    expect(loadSettings(storage).viewport.environment).toEqual(DEFAULT_SETTINGS.viewport.environment);
  });

  it("accepts v3 environment settings and applies lighting defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        settings: {
          viewport: {
            environment: {
              enabled: false,
              path: "",
              rotationDegrees: 0,
              intensity: 1,
            },
          },
          console: { minimumLevel: "info", autoScroll: true },
        },
      }),
    );

    expect(loadSettings(storage).viewport.lighting).toEqual(DEFAULT_SETTINGS.viewport.lighting);
  });

  it("accepts v4 settings and applies the default UI scale", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 4,
        settings: {
          viewport: { debugOverlay: true },
          console: { minimumLevel: "info", autoScroll: true },
        },
      }),
    );

    expect(loadSettings(storage).ui).toEqual(DEFAULT_SETTINGS.ui);
  });

  it("rejects unsupported UI scales independently", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { ui: { scale: 1.1 } },
      }),
    );

    expect(loadSettings(storage).ui).toEqual(DEFAULT_SETTINGS.ui);
  });

  it("rejects malformed lighting values independently", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: {
          viewport: {
            lighting: {
              exposure: -1,
              tonemap: "agx",
              ambientIntensity: 99,
              ambientColor: "red",
              shadowsEnabled: "yes",
              shadowResolution: 4096,
              shadowSoftness: -1,
              backgroundMode: "image",
              backgroundColor: "#123",
            },
          },
        },
      }),
    );
    expect(loadSettings(storage).viewport.lighting).toEqual(DEFAULT_SETTINGS.viewport.lighting);
  });

  it("falls back for an oversized persisted environment path", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { viewport: { environment: { path: "p".repeat(4_097) } } },
      }),
    );
    expect(loadSettings(storage).viewport.environment.path).toBe(DEFAULT_SETTINGS.viewport.environment.path);
  });

  it("fails closed before parsing an oversized storage payload", () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, `{"version":${SETTINGS_VERSION},"settings":{"console":{"minimumLevel":"info","autoScroll":true},"padding":"${"x".repeat(300_000)}"}}`);
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("does not throw when the storage implementation fails", () => {
    const brokenStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(loadSettings(brokenStorage)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(DEFAULT_SETTINGS, brokenStorage)).toBe(false);
  });
});
