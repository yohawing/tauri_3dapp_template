import type { TimelinePlaybackSnapshot } from "./playback";

export type PlaybackConnectionState =
  | { kind: "browser-preview" }
  | { kind: "native-loading"; latestRevision: number }
  | { kind: "native-available"; snapshot: TimelinePlaybackSnapshot; latestRevision: number }
  | { kind: "native-unavailable"; latestRevision: number };

export interface PlaybackSnapshotAcceptance {
  state: PlaybackConnectionState;
  accepted: boolean;
}

export function createPlaybackConnectionState(hasTauriRuntime: boolean): PlaybackConnectionState {
  return hasTauriRuntime
    ? { kind: "native-loading", latestRevision: 0 }
    : { kind: "browser-preview" };
}

function latestRevision(state: PlaybackConnectionState): number {
  switch (state.kind) {
    case "native-loading":
    case "native-unavailable":
      return state.latestRevision;
    case "native-available":
      return state.latestRevision;
    case "browser-preview":
      return -1;
  }
}

/**
 * Accepts authoritative Native snapshots while preserving the explicit
 * browser-only preview state. Equal revisions are accepted because Rust may
 * publish a corrected time/availability snapshot without advancing the
 * scene revision; only lower revisions are stale.
 */
export function reducePlaybackConnection(
  state: PlaybackConnectionState,
  snapshot: TimelinePlaybackSnapshot,
): PlaybackConnectionState {
  return acceptPlaybackSnapshot(state, snapshot).state;
}

function hasSameTargetMetadata(
  current: TimelinePlaybackSnapshot,
  next: TimelinePlaybackSnapshot,
): boolean {
  return current.available === next.available &&
    current.instanceId === next.instanceId &&
    current.clipIndex === next.clipIndex &&
    current.duration === next.duration;
}

/**
 * Returns both the canonical connection state and whether this snapshot was
 * accepted. Accepted time/playing updates with unchanged target metadata keep
 * the state object stable; callers can still consume the fresh snapshot via
 * their live ref without repainting the whole Timeline.
 */
export function acceptPlaybackSnapshot(
  state: PlaybackConnectionState,
  snapshot: TimelinePlaybackSnapshot,
): PlaybackSnapshotAcceptance {
  if (state.kind === "browser-preview" || snapshot.revision < latestRevision(state)) {
    return { state, accepted: false };
  }
  if (!snapshot.available) {
    if (state.kind === "native-unavailable" && state.latestRevision === snapshot.revision) {
      return { state, accepted: true };
    }
    return {
      state: {
        kind: "native-unavailable",
        latestRevision: snapshot.revision,
      },
      accepted: true,
    };
  }
  if (
    state.kind === "native-available" &&
    state.latestRevision === snapshot.revision &&
    hasSameTargetMetadata(state.snapshot, snapshot)
  ) {
    return { state, accepted: true };
  }
  return {
    state: {
      kind: "native-available",
      snapshot,
      latestRevision: snapshot.revision,
    },
    accepted: true,
  };
}

export function playbackControlsEnabled(state: PlaybackConnectionState): boolean {
  return state.kind === "browser-preview" || state.kind === "native-available";
}
