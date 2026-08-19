import { describe, expect, it, vi } from "vitest";
import {
  createTimelineEditorPlaybackController,
  stopTimelineEditorPlaybackController,
  toNativeTimelinePlaybackCommand,
  toTimelineEditorPlaybackSnapshot,
} from "./timelineEditorPlaybackController";
import type { TimelinePlaybackSnapshot } from "../playback";

const snapshot = (overrides: Partial<TimelinePlaybackSnapshot> = {}): TimelinePlaybackSnapshot => ({
  epoch: 3,
  revision: 7,
  sampledAtUnixMs: 1000,
  emittedAtUnixMs: 1000,
  eventSequence: 4,
  available: true,
  instanceId: "scene-a",
  clipIndex: 2,
  time: 1.5,
  duration: 10,
  playing: true,
  looping: false,
  commandResults: [],
  ...overrides,
});

describe("Timeline package playback adapter", () => {
  it("projects the native target and sample timestamp", () => {
    expect(toTimelineEditorPlaybackSnapshot(snapshot())).toEqual({
      available: true,
      time: 1.5,
      duration: 10,
      playing: true,
      looping: false,
      target: { instanceId: "scene-a", clipIndex: 2 },
      sampledAtUnixMs: 1000,
    });
    expect(toTimelineEditorPlaybackSnapshot(snapshot({ available: false, instanceId: null, clipIndex: null })))
      .toEqual({ available: false, time: 0, duration: 0, playing: false, looping: false });
  });

  it("preserves the package-selected target on each native command", () => {
    const current = snapshot();
    expect(toNativeTimelinePlaybackCommand({ type: "play", target: { instanceId: "selected", clipIndex: 4 } }, current))
      .toEqual({ type: "play", instanceId: "selected", clipIndex: 4 });
    expect(toNativeTimelinePlaybackCommand({ type: "seek", target: { instanceId: "selected", clipIndex: 4 }, time: 2.25 }, current))
      .toEqual({ type: "seek", instanceId: "selected", clipIndex: 4, time: 2.25 });
    expect(toNativeTimelinePlaybackCommand({ type: "setLooping", target: null, looping: true }, current))
      .toEqual({ type: "setLooping", instanceId: "scene-a", clipIndex: 2, looping: true });
  });

  it("caches snapshots and forwards commands through the injected host", async () => {
    let current: TimelinePlaybackSnapshot | null = snapshot();
    const listener = vi.fn();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const controller = createTimelineEditorPlaybackController({
      getSnapshot: () => current,
      subscribe: (callback) => {
        listener.mockImplementation(callback);
        return () => undefined;
      },
      dispatch,
    });
    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
    await controller.dispatch({ type: "pause", target: { instanceId: "selected", clipIndex: 4 } });
    expect(dispatch).toHaveBeenCalledWith(
      { type: "pause", instanceId: "selected", clipIndex: 4 },
      3,
    );
    expect(controller.subscribe).toBeDefined();
    current = null;
    listener();
    await expect(controller.dispatch({ type: "play", target: null })).rejects.toThrow("unavailable");
  });

  it("stops a local controller through its public pause command during cleanup", () => {
    const dispatch = vi.fn();
    stopTimelineEditorPlaybackController({
      getSnapshot: () => ({ available: true, time: 0, duration: 2, playing: true, looping: false }),
      subscribe: () => () => undefined,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "pause", target: null });
  });
});
