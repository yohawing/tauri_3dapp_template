import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./model";
import { updateSettings } from "./SettingsModal";

describe("SettingsModal updates", () => {
  it("composes rapid updates from the latest committed snapshot", () => {
    const first = updateSettings(DEFAULT_SETTINGS, (current) => ({
      ...current,
      viewport: { ...current.viewport, debugOverlay: true },
    }));
    const second = updateSettings(first, (current) => ({
      ...current,
      console: { ...current.console, autoScroll: false },
    }));

    expect(second.viewport.debugOverlay).toBe(true);
    expect(second.console.autoScroll).toBe(false);
  });
});
