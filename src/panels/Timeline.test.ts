import { describe, expect, it } from "vitest";
import { formatTimelinePlaybackStatus, visibleTimelineRowQuery, visibleTimelineTicks } from "./Timeline";
import { createPlaybackConnectionState } from "../timeline/playbackState";
import type { TimelinePlaybackSnapshot } from "../timeline/playback";

describe("Timeline virtual row queries", () => {
  it("keeps a legal row after the old 10k materialization limit addressable", () => {
    expect(visibleTimelineRowQuery(10_001, 10_000 * 26, 1)).toEqual({ start: 10_000, count: 1 });
  });

  it("clamps a viewport page to the total row count", () => {
    expect(visibleTimelineRowQuery(10_001, 10_000 * 26, 260)).toEqual({ start: 10_000, count: 1 });
  });

  it("falls back to the standard row height for invalid custom heights", () => {
    expect(visibleTimelineRowQuery(100, 26, 1, 0)).toEqual({ start: 1, count: 2 });
    expect(visibleTimelineRowQuery(100, 26, 1, Number.NaN)).toEqual({ start: 1, count: 2 });
  });
});

describe("Timeline visible ruler ticks", () => {
  it("generates a bounded viewport page with edge overscan", () => {
    const ticks = visibleTimelineTicks(120, 600, 120, 10, 1);
    expect(ticks[0]).toBe(58);
    expect(ticks.at(-1)).toBe(74);
    expect(ticks).toHaveLength(17);
  });

  it("clamps ticks at the timeline end", () => {
    expect(visibleTimelineTicks(12, 0, 120, 10, 1)).toEqual(
      Array.from({ length: 13 }, (_, index) => index),
    );
  });

  it("keeps extreme durations bounded", () => {
    const ticks = visibleTimelineTicks(1e12, 0, 1e9, 1, 1);
    expect(ticks).toHaveLength(512);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(511);
  });
});

describe("Timeline playback status", () => {
  it("exposes connection and play state without announcing playhead frames", () => {
    expect(formatTimelinePlaybackStatus(createPlaybackConnectionState(false), false)).toBe(
      "Timeline preview paused.",
    );
    expect(formatTimelinePlaybackStatus(createPlaybackConnectionState(true), false)).toBe(
      "Connecting to Native playback.",
    );

    const snapshot: TimelinePlaybackSnapshot = {
      epoch: 1,
      revision: 1,
      sampledAtUnixMs: 0,
      emittedAtUnixMs: 0,
      eventSequence: 1,
      available: true,
      instanceId: "instance",
      clipIndex: 0,
      time: 0,
      duration: 1,
      playing: false,
      looping: false,
      commandResults: [],
    };
    expect(formatTimelinePlaybackStatus({ kind: "native-available", snapshot, latestRevision: 1 }, true)).toBe(
      "Native playback playing.",
    );
    expect(formatTimelinePlaybackStatus({ kind: "native-unavailable", latestEpoch: 1, latestRevision: 2 }, false)).toBe(
      "Native playback unavailable.",
    );
  });
});
