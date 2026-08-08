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
    first.viewport.debugOverlay = false;

    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(first).not.toBe(DEFAULT_SETTINGS);
  });

  it("restores a saved v1 payload", () => {
    const storage = new MemoryStorage();
    const settings = {
      viewport: { debugOverlay: false },
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
      viewport: { debugOverlay: false },
      console: {
        minimumLevel: DEFAULT_SETTINGS.console.minimumLevel,
        autoScroll: DEFAULT_SETTINGS.console.autoScroll,
      },
    });
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
