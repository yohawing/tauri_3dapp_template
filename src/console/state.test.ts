import { describe, expect, it } from "vitest";
import {
  formatConsoleEntries,
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
});
