import { describe, expect, it } from "vitest";
import {
  clampConsoleDrawerHeight,
  consoleEntryRenderKeys,
  consoleDrawerHeightForKey,
  formatConsoleLiveAnnouncement,
  getConsoleDrawerMaxHeight,
  isActiveConsoleResizePointer,
} from "./ConsoleDrawer";
import type { ConsoleEntry } from "./contracts";
import { MAX_SEARCH_QUERY_BYTES, normalizeSearchQuery } from "../searchQuery";

describe("Console drawer resize accessibility", () => {
  it("uses the existing minimum and viewport-based maximum", () => {
    expect(getConsoleDrawerMaxHeight(1000)).toBe(650);
    expect(getConsoleDrawerMaxHeight(100)).toBe(120);
    expect(clampConsoleDrawerHeight(40, 650)).toBe(120);
    expect(clampConsoleDrawerHeight(700, 650)).toBe(650);
  });

  it("maps separator keyboard controls to clamped heights", () => {
    expect(consoleDrawerHeightForKey("ArrowUp", 220, 650)).toBe(236);
    expect(consoleDrawerHeightForKey("ArrowDown", 120, 650)).toBe(120);
    expect(consoleDrawerHeightForKey("Home", 220, 650)).toBe(120);
    expect(consoleDrawerHeightForKey("End", 220, 650)).toBe(650);
    expect(consoleDrawerHeightForKey("PageUp", 220, 650)).toBeNull();
  });

  it("only accepts pointer termination for the active resize pointer", () => {
    expect(isActiveConsoleResizePointer(4, 4)).toBe(true);
    expect(isActiveConsoleResizePointer(4, 5)).toBe(false);
    expect(isActiveConsoleResizePointer(null, 4)).toBe(false);
  });

  it("keeps repeated entry objects on distinct render keys", () => {
    const entry: ConsoleEntry = {
      timestamp: "2026-08-12T00:00:00.000Z",
      level: "info",
      source: "frontend",
      message: "same object",
    };
    expect(new Set(consoleEntryRenderKeys([entry, entry])).size).toBe(2);
  });

  it("changes live text for repeated entries and announces clear", () => {
    const entry: ConsoleEntry = {
      timestamp: "2026-08-12T00:00:00.000Z",
      level: "info",
      source: "frontend",
      message: "same object",
    };
    expect(formatConsoleLiveAnnouncement(entry, false)).not.toBe(formatConsoleLiveAnnouncement(entry, true));
    expect(formatConsoleLiveAnnouncement(entry, true)).toContain("Another");
    expect(formatConsoleLiveAnnouncement(undefined, false)).toBe("Console cleared.");
  });

  it("bounds long console searches by UTF-8 bytes", () => {
    const query = normalizeSearchQuery("😀".repeat(2_000));
    expect(new TextEncoder().encode(query).byteLength).toBeLessThanOrEqual(MAX_SEARCH_QUERY_BYTES);
  });
});
