import { describe, expect, it } from "vitest";
import {
  projectTimelinePlaybackTime,
  timelineEventAges,
  timelineSequenceGap,
  type TimelinePlaybackSnapshot,
} from "./playback";

const snapshot = (overrides: Partial<TimelinePlaybackSnapshot> = {}): TimelinePlaybackSnapshot => ({
  revision: 1,
  sampledAtUnixMs: 10_000,
  emittedAtUnixMs: 10_012,
  eventSequence: 1,
  available: true,
  instanceId: "model",
  clipIndex: 0,
  time: 1,
  duration: 3,
  playing: true,
  looping: true,
  ...overrides,
});

describe("projectTimelinePlaybackTime", () => {
  it("projects a playing snapshot without mutating the Native source time", () => {
    expect(projectTimelinePlaybackTime(snapshot(), 10_500)).toBe(1.5);
    expect(projectTimelinePlaybackTime(snapshot({ playing: false }), 10_500)).toBe(1);
  });

  it("wraps looping playback and clamps non-looping playback", () => {
    expect(projectTimelinePlaybackTime(snapshot({ time: 2.8 }), 10_500)).toBeCloseTo(0.3);
    expect(projectTimelinePlaybackTime(snapshot({ time: 2.8, looping: false }), 10_500)).toBe(3);
  });

  it("ignores a future timestamp instead of projecting backwards", () => {
    expect(projectTimelinePlaybackTime(snapshot(), 9_500)).toBe(1);
  });
});

describe("timeline event instrumentation", () => {
  it("splits canonical sample-to-emit and emit-to-listener age", () => {
    expect(timelineEventAges(snapshot(), 10_030)).toEqual({
      sampleToEmitAgeMs: 12,
      emitToListenerAgeMs: 18,
      totalDeliveryAgeMs: 30,
    });
    expect(timelineEventAges(snapshot({ emittedAtUnixMs: 9_900 }), 10_000)).toEqual({
      sampleToEmitAgeMs: 0,
      emitToListenerAgeMs: 100,
      totalDeliveryAgeMs: 100,
    });
  });

  it("counts missing and out-of-order sequence values", () => {
    expect(timelineSequenceGap(undefined, 1)).toBe(0);
    expect(timelineSequenceGap(1, 2)).toBe(0);
    expect(timelineSequenceGap(1, 4)).toBe(2);
    expect(timelineSequenceGap(4, 2)).toBe(1);
  });
});
