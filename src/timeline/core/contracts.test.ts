import { describe, expect, it } from "vitest";
import { fixtureTimelineDataSource } from "../adapters/fixtureDataSource";
import { createViewTransform, normalizeTime, overlapsHalfOpen } from "./contracts";

describe("timeline display contracts", () => {
  it("round-trips time and canvas coordinates", () => {
    const transform = createViewTransform(1.25, 80);

    expect(transform.timeToX(3.75)).toBe(200);
    expect(transform.xToTime(200)).toBe(3.75);
  });

  it("uses half-open ranges", () => {
    expect(overlapsHalfOpen({ start: 0, end: 2 }, { start: 2, end: 4 })).toBe(false);
    expect(overlapsHalfOpen({ start: 0, end: 2.01 }, { start: 2, end: 4 })).toBe(true);
  });

  it("keeps seconds continuous and ticks integral", () => {
    expect(normalizeTime({ kind: "seconds" }, 1.25)).toBe(1.25);
    expect(normalizeTime({ kind: "ticks", ticksPerSecond: 48_000 }, 60_000)).toBe(60_000);
    expect(() => normalizeTime({ kind: "seconds" }, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => normalizeTime({ kind: "ticks", ticksPerSecond: 48_000 }, 1.5)).toThrow();
  });

  it("keeps groups and bindings as separate entities", () => {
    const groupIds = new Set<string>(fixtureTimelineDataSource.getGroups().map((group) => group.id));
    const bindingIds = new Set<string>(fixtureTimelineDataSource.getBindings().map((binding) => binding.id));

    expect(groupIds.size).toBeGreaterThan(0);
    expect(bindingIds.size).toBeGreaterThan(0);
    expect([...groupIds].some((id) => bindingIds.has(id))).toBe(false);
  });

  it("keeps markers and event cues as separate item kinds", () => {
    const rows = fixtureTimelineDataSource.getRows({ start: 0, count: 100 });
    const items = fixtureTimelineDataSource.getItems({
      rowIds: rows.map((row) => row.id),
      range: { start: 0, end: 12 },
    });

    expect(items.some((item) => item.kind === "marker")).toBe(true);
    expect(items.some((item) => item.kind === "event-cue")).toBe(true);
  });
});
