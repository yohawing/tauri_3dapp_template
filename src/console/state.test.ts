import { describe, expect, it, vi } from "vitest";
import {
  formatConsoleEntries,
  MAX_CONSOLE_MESSAGE_LENGTH,
  boundedDiagnosticText,
  normalizeConsoleDiagnostic,
  safeDiagnosticText,
  selectVisibleConsoleEntries,
  type ConsoleEntry,
} from "./contracts";
import { createConsoleState, createConsoleStore, reduceConsoleState } from "./state";

function entry(index: number, level: ConsoleEntry["level"] = "info"): ConsoleEntry {
  return {
    timestamp: `2026-08-08T00:00:0${index}.000Z`,
    level,
    source: index % 2 === 0 ? "scene" : "frontend",
    message: `diagnostic-${index}`,
  };
}

describe("console state model", () => {
  it("keeps only the newest entries in its bounded ring buffer", () => {
    let state = createConsoleState({ capacity: 2 });
    state = reduceConsoleState(state, { type: "append", entry: entry(1) });
    state = reduceConsoleState(state, { type: "appendMany", entries: [entry(2), entry(3)] });

    expect(state.entries.map((item) => item.message)).toEqual(["diagnostic-2", "diagnostic-3"]);
  });

  it("filters by minimum level without mutating the retained order", () => {
    const entries = [entry(1, "info"), entry(2, "error"), entry(3, "warn"), entry(4, "info")];
    expect(selectVisibleConsoleEntries(entries, "warn").map((item) => item.level)).toEqual([
      "error",
      "warn",
    ]);
    expect(selectVisibleConsoleEntries(entries, "all")).toBe(entries);
  });

  it("clears retained entries while preserving filter and auto-scroll settings", () => {
    let state = createConsoleState({ capacity: 4, levelFilter: "warn", autoScroll: false });
    state = reduceConsoleState(state, { type: "append", entry: entry(1, "error") });
    state = reduceConsoleState(state, { type: "clear" });

    expect(state.entries).toEqual([]);
    expect(state.levelFilter).toBe("warn");
    expect(state.autoScroll).toBe(false);
  });

  it("pauses auto-scroll while browsing and resumes explicitly", () => {
    let state = createConsoleState();
    state = reduceConsoleState(state, { type: "setAutoScroll", enabled: false });
    state = reduceConsoleState(state, { type: "append", entry: entry(1, "warn") });
    expect(state.autoScroll).toBe(false);

    state = reduceConsoleState(state, { type: "setAutoScroll", enabled: true });
    expect(state.autoScroll).toBe(true);
  });

  it("notifies subscribers only when the model changes and formats Copy All text", () => {
    const store = createConsoleStore({ capacity: 2 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.setAutoScroll(true); // no-op
    store.append(entry(1, "error"));
    store.clear();
    unsubscribe();
    store.append(entry(2));

    expect(notifications).toBe(2);
    expect(formatConsoleEntries([entry(5, "warn")])).toContain("[WARN] [frontend] diagnostic-5");
  });

  it("continues notifying subscribers when one subscriber throws", () => {
    const store = createConsoleStore();
    const first = vi.fn(() => { throw new Error("subscriber failed"); });
    const second = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      store.subscribe(first);
      store.subscribe(second);
      expect(() => store.append(entry(1))).not.toThrow();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("normalizes diagnostic events and keeps unknown sources in frontend", () => {
    expect(normalizeConsoleDiagnostic({ level: "warn", source: "timeline", message: "late event" })).toEqual({
      level: "warn",
      source: "timeline",
      message: "late event",
    });
    expect(normalizeConsoleDiagnostic({ level: "info", source: "plugin", message: "external" })).toEqual({
      level: "info",
      source: "frontend",
      message: "external",
    });
    expect(normalizeConsoleDiagnostic({ level: "debug", source: "scene", message: "ignored" })).toBeNull();
    expect(normalizeConsoleDiagnostic(null)).toBeNull();
  });

  it("fails closed for diagnostic payloads with throwing getters", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile diagnostic getter");
      },
    });

    expect(() => normalizeConsoleDiagnostic(hostile)).not.toThrow();
    expect(normalizeConsoleDiagnostic(hostile)).toBeNull();
  });

  it("bounds untrusted diagnostic messages before retaining them", () => {
    const message = "x".repeat(MAX_CONSOLE_MESSAGE_LENGTH + 100);
    const normalized = normalizeConsoleDiagnostic({ level: "error", source: "scene", message });

    expect(normalized?.message).toBe(`${"x".repeat(MAX_CONSOLE_MESSAGE_LENGTH)}…`);
  });

  it("keeps copied diagnostics line-oriented and neutralizes control characters", () => {
    const normalized = normalizeConsoleDiagnostic({
      level: "warn",
      source: "scene",
      message: "first\n[ERROR] forged\t\u202e reversed",
    });

    expect(normalized?.message).toBe("first [ERROR] forged � reversed");
    expect(formatConsoleEntries([
      { timestamp: "2026-08-08T00:00:00.000Z", ...normalized! },
    ])).not.toContain("\n[ERROR]");
  });

  it("converts hostile rejection values without throwing", () => {
    const nullPrototype = Object.create(null) as object;
    const throwingToString = { toString: () => { throw new Error("coercion failed"); } };

    expect(safeDiagnosticText(new Error("native failed"))).toBe("Error: native failed");
    expect(safeDiagnosticText(nullPrototype)).toBe("Unknown error");
    expect(safeDiagnosticText(throwingToString)).toBe("Unknown error");
  });

  it("bounds command-result text by UTF-8 bytes", () => {
    const text = boundedDiagnosticText("あ".repeat(4_000), 4_096);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4_096);
    expect(text).not.toContain("\n");
  });

  it("does not leave a split surrogate at the UTF-8 boundary", () => {
    const text = boundedDiagnosticText(`${"a".repeat(4_093)}😀`);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4_096);
    const last = text.charCodeAt(text.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
  });
});
