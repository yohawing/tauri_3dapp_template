import { describe, expect, it } from "vitest";
import {
  createPlaybackConnectionState,
  playbackControlsEnabled,
  acceptPlaybackSnapshot,
  reducePlaybackConnection,
} from "./playbackState";
import type { TimelinePlaybackSnapshot } from "./playback";

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

describe("playback connection state", () => {
  it("distinguishes browser preview from Native loading", () => {
    expect(createPlaybackConnectionState(false)).toEqual({ kind: "browser-preview" });
    expect(createPlaybackConnectionState(true)).toEqual({ kind: "native-loading", latestRevision: 0 });
    expect(playbackControlsEnabled(createPlaybackConnectionState(false))).toBe(true);
    expect(playbackControlsEnabled(createPlaybackConnectionState(true))).toBe(false);
  });

  it("accepts available -> unavailable and drops the target", () => {
    const available = reducePlaybackConnection(createPlaybackConnectionState(true), snapshot({ revision: 4 }));
    const unavailable = reducePlaybackConnection(available, snapshot({ revision: 5, available: false, playing: false }));

    expect(unavailable).toEqual({ kind: "native-unavailable", latestRevision: 5 });
    expect(playbackControlsEnabled(unavailable)).toBe(false);
  });

  it("rejects stale unavailable snapshots without resurrecting old Native state", () => {
    const available = reducePlaybackConnection(createPlaybackConnectionState(true), snapshot({ revision: 8 }));
    const stale = reducePlaybackConnection(available, snapshot({ revision: 7, available: false }));

    expect(stale).toBe(available);
  });

  it("accepts unavailable -> available only at an equal or newer revision", () => {
    const unavailable = reducePlaybackConnection(
      createPlaybackConnectionState(true),
      snapshot({ revision: 3, available: false }),
    );
    const available = reducePlaybackConnection(
      unavailable,
      snapshot({ revision: 3, available: true, instanceId: "new-model", time: 0 }),
    );

    expect(available).toMatchObject({
      kind: "native-available",
      snapshot: { revision: 3, instanceId: "new-model", time: 0 },
      latestRevision: 3,
    });
    expect(playbackControlsEnabled(available)).toBe(true);
  });

  it("accepts time-only updates without changing the connection state identity", () => {
    const first = reducePlaybackConnection(createPlaybackConnectionState(true), snapshot({ revision: 9 }));
    const acceptance = acceptPlaybackSnapshot(
      first,
      snapshot({ revision: 9, time: 2.25, sampledAtUnixMs: 10_250 }),
    );

    expect(acceptance.accepted).toBe(true);
    expect(acceptance.state).toBe(first);
  });

  it("keeps repeated unavailable revisions targetless and fail-closed", () => {
    const first = reducePlaybackConnection(
      createPlaybackConnectionState(true),
      snapshot({ revision: 6, available: false, instanceId: "old-model" }),
    );
    const repeated = reducePlaybackConnection(
      first,
      snapshot({ revision: 6, available: false, instanceId: null, clipIndex: null }),
    );

    expect(repeated).toEqual({ kind: "native-unavailable", latestRevision: 6 });
    expect(playbackControlsEnabled(repeated)).toBe(false);
  });
});
