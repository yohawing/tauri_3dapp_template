import { describe, expect, it } from "vitest";
import { projectTimelinePlaybackTime, type TimelinePlaybackSnapshot } from "./playback";

const snapshot = (overrides: Partial<TimelinePlaybackSnapshot> = {}): TimelinePlaybackSnapshot => ({
  revision: 1,
  sampledAtUnixMs: 10_000,
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
