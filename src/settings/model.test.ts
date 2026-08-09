import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  loadSettings,
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
  it("returns independent defaults when no persisted value exists", () => {
    const first = loadSettings(null);
    first.viewport.debugOverlay = true;

    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(first).not.toBe(DEFAULT_SETTINGS);
  });

  it("restores a saved v4 payload", () => {
    const storage = new MemoryStorage();
    const settings = {
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
