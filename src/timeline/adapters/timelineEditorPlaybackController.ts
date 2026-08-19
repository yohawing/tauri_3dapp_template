import type {
  TimelinePlaybackCommand as PackagePlaybackCommand,
  TimelinePlaybackController as PackagePlaybackController,
  TimelinePlaybackSnapshot as PackagePlaybackSnapshot,
  TimelinePlaybackTarget as PackagePlaybackTarget,
} from "@yohawing/timeline-editor/core";
import {
  resolveTimelinePlaybackTarget,
  type TimelinePlaybackCommand as NativePlaybackCommand,
  type TimelinePlaybackSnapshot as NativePlaybackSnapshot,
} from "../playback";

export interface TimelineEditorPlaybackAdapterDependencies {
  getSnapshot: () => NativePlaybackSnapshot | null;
  subscribe: (listener: () => void) => () => void;
  dispatch: (command: NativePlaybackCommand, epoch: number) => void | Promise<void>;
}

/** Stop a host-owned local preview when its React owner is disposed. */
export function stopTimelineEditorPlaybackController(
  controller: PackagePlaybackController,
): void {
  try {
    const result = controller.dispatch({ type: "pause", target: null });
    if (result && typeof (result as PromiseLike<void>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Cleanup must not turn an unmount into an uncaught transport error.
  }
}

/** Convert the rich, validated Tauri snapshot to the package's transport-neutral shape. */
export function toTimelineEditorPlaybackSnapshot(
  snapshot: NativePlaybackSnapshot | null,
): PackagePlaybackSnapshot {
  if (!snapshot || !snapshot.available || !snapshot.instanceId || snapshot.clipIndex === null) {
    return {
      available: false,
      time: 0,
      duration: 0,
      playing: false,
      looping: false,
    };
  }
  return {
    available: true,
    time: snapshot.time,
    duration: snapshot.duration,
    playing: snapshot.playing,
    looping: snapshot.looping,
    target: { instanceId: snapshot.instanceId, clipIndex: snapshot.clipIndex },
    sampledAtUnixMs: snapshot.sampledAtUnixMs,
  };
}

function packageTargetToNative(target: PackagePlaybackTarget | null): PackagePlaybackTarget | null {
  if (!target || !target.instanceId || !Number.isSafeInteger(target.clipIndex) || target.clipIndex < 0) {
    return null;
  }
  return { instanceId: target.instanceId, clipIndex: target.clipIndex };
}

/** Map package commands back to the unchanged target-bearing Tauri wire command. */
export function toNativeTimelinePlaybackCommand(
  command: PackagePlaybackCommand,
  fallbackSnapshot: NativePlaybackSnapshot | null,
): NativePlaybackCommand | null {
  const target = packageTargetToNative(command.target) ??
    resolveTimelinePlaybackTarget(null, fallbackSnapshot);
  if (!target) return null;
  switch (command.type) {
    case "play":
      return { type: "play", ...target };
    case "pause":
      return { type: "pause", ...target };
    case "seek":
      return { type: "seek", ...target, time: command.time };
    case "setLooping":
      return { type: "setLooping", ...target, looping: command.looping };
  }
}

/**
 * Host adapter for the package component. It caches the projected snapshot so
 * useSyncExternalStore observes a stable value between native events.
 */
export function createTimelineEditorPlaybackController(
  dependencies: TimelineEditorPlaybackAdapterDependencies,
): PackagePlaybackController {
  let cachedNativeSnapshot: NativePlaybackSnapshot | null | undefined;
  let cachedPackageSnapshot: PackagePlaybackSnapshot | undefined;
  return {
    getSnapshot: () => {
      const nativeSnapshot = dependencies.getSnapshot();
      if (nativeSnapshot === cachedNativeSnapshot && cachedPackageSnapshot) {
        return cachedPackageSnapshot;
      }
      cachedNativeSnapshot = nativeSnapshot;
      cachedPackageSnapshot = toTimelineEditorPlaybackSnapshot(nativeSnapshot);
      return cachedPackageSnapshot;
    },
    subscribe: dependencies.subscribe,
    dispatch: (command) => {
      const nativeSnapshot = dependencies.getSnapshot();
      if (!nativeSnapshot?.available) {
        return Promise.reject(new Error("Native Timeline playback is unavailable"));
      }
      const nativeCommand = toNativeTimelinePlaybackCommand(command, nativeSnapshot);
      if (!nativeCommand) {
        return Promise.reject(new Error("Timeline playback target is unavailable"));
      }
      return dependencies.dispatch(nativeCommand, nativeSnapshot.epoch);
    },
  };
}
