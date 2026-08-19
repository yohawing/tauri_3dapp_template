import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { TimelineEditor } from "@yohawing/timeline-editor";
import { createLocalPlaybackController } from "@yohawing/timeline-editor/core";
import "@yohawing/timeline-editor/styles.css";
import { boundedDiagnosticText, safeDiagnosticText } from "../console/contracts";
import { createSelfTestTimerBag } from "../selfTestTimers";
import { runtimeTimelineDataSource } from "../timeline/adapters/gltfProjectionDataSource";
import {
  type TimelineDataSource,
} from "../timeline/core/contracts";
import {
  createTimelinePlaybackDispatcher,
  createTimelinePlaybackListener,
  getTimelinePlayback,
  reportTimelineEventPerformance,
  resolveTimelinePlaybackTarget,
  subscribeTimelinePlayback,
  timelineEventAges,
  timelineSequenceGap,
  createTimelinePlaybackCommandFlight,
  timelinePlaybackCommandResultMatchesFlight,
  shouldRollbackTimelinePlaybackCommand,
  type TimelinePlaybackCommand,
  type TimelinePlaybackCommandFlight,
  type TimelinePlaybackSnapshot,
} from "../timeline/playback";
import {
  acceptPlaybackSnapshot,
  createPlaybackConnectionState,
  type PlaybackConnectionState,
} from "../timeline/playbackState";
import {
  createTimelineEditorPlaybackController,
  stopTimelineEditorPlaybackController,
} from "../timeline/adapters/timelineEditorPlaybackController";
import "./Timeline.css";

export {
  visibleTimelineRowQuery,
  visibleTimelineTicks,
} from "@yohawing/timeline-editor/core";

const TIMELINE_FPS = 24;
const NATIVE_PLAYBACK_EVENT_INTERVAL_MS = 250;
let timelineSelfTestHasRun = false;
let timelinePlaybackSelfTestHasRun = false;
const activeTimelineSelfTestCleanups = new Set<() => void>();

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function reportTimelineDiagnostic(level: "info" | "warn" | "error", message: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("tauri3d:diagnostic", {
      detail: { level, source: "timeline", message },
    }));
  } catch {
    // Diagnostics are best effort; playback state remains authoritative.
  }
}

/** Keep a rejected native transport command visible after optimistic rollback. */
function reportTimelinePlaybackCommandFailure(error: unknown): void {
  const message = `Native playback command failed; rolled back: ${boundedDiagnosticText(error)}`;
  try {
    console.warn("[Timeline]", message);
  } catch {
    // Embedding hosts may replace console methods with throwing shims.
  }
  reportTimelineDiagnostic("error", message);
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }));
  } catch {
    // Rollback already restored the native snapshot; diagnostics are best effort.
  }
}

function registerTimelineSelfTestCleanup(cleanup: () => void): () => void {
  activeTimelineSelfTestCleanups.add(cleanup);
  return () => activeTimelineSelfTestCleanups.delete(cleanup);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeTimelineSelfTestCleanups.forEach((cleanup) => cleanup());
    activeTimelineSelfTestCleanups.clear();
    timelineSelfTestHasRun = false;
    timelinePlaybackSelfTestHasRun = false;
  });
}

export function formatTimelinePlaybackStatus(
  connection: PlaybackConnectionState,
  isPlaying: boolean,
): string {
  switch (connection.kind) {
    case "browser-preview":
      return isPlaying ? "Timeline preview playing." : "Timeline preview paused.";
    case "native-loading":
      return "Connecting to Native playback.";
    case "native-unavailable":
      return "Native playback unavailable.";
    case "native-available":
      return isPlaying ? "Native playback playing." : "Native playback paused.";
  }
}

export interface TimelineProps {
  dataSource?: TimelineDataSource;
  variant?: "compact" | "full";
  frameRate?: number;
  displayMode?: "frames" | "seconds";
}

export function Timeline({
  dataSource = runtimeTimelineDataSource,
  variant = "compact",
  frameRate = TIMELINE_FPS,
  displayMode = "frames",
}: TimelineProps) {
  const revision = useSyncExternalStore(
    dataSource.subscribe,
    dataSource.getRevision,
    dataSource.getRevision,
  );
  const runtime = hasTauriRuntime();
  const [playbackConnection, setPlaybackConnection] = useState<PlaybackConnectionState>(() =>
    createPlaybackConnectionState(runtime),
  );
  const playbackConnectionRef = useRef<PlaybackConnectionState>(playbackConnection);
  const nativePlaybackRef = useRef<TimelinePlaybackSnapshot | null>(null);
  const acceptedPlaybackRef = useRef<TimelinePlaybackSnapshot | null>(null);
  const acceptedPlaybackGenerationRef = useRef(0);
  const playbackFlightIdRef = useRef(0);
  const playbackFlightRef = useRef<TimelinePlaybackCommandFlight | null>(null);
  const lastCommandResultSequenceRef = useRef(0);
  const nativePlaybackEpochRef = useRef(0);
  const playbackDispatcherRef = useRef<ReturnType<typeof createTimelinePlaybackDispatcher> | null>(null);
  const playbackListenersRef = useRef(new Set<() => void>());

  const notifyPlaybackListeners = useCallback(() => {
    playbackListenersRef.current.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.warn("[Timeline] package playback subscriber failed", error);
      }
    });
  }, []);
  const dispatchPlayback = useCallback((command: TimelinePlaybackCommand, epoch: number, requestId?: number) => {
    const dispatcher = playbackDispatcherRef.current ?? createTimelinePlaybackDispatcher();
    playbackDispatcherRef.current = dispatcher;
    return dispatcher.dispatch(command, epoch, requestId);
  }, []);

  useEffect(() => () => {
    playbackDispatcherRef.current?.dispose();
    playbackDispatcherRef.current = null;
  }, []);

  const dispatchNativeCommand = useCallback(async (command: TimelinePlaybackCommand, epoch: number) => {
    const currentPlayback = nativePlaybackRef.current;
    if (!currentPlayback?.available || !currentPlayback.instanceId || currentPlayback.clipIndex === null) {
      throw new Error("Native Timeline playback is unavailable");
    }
    if (currentPlayback.epoch !== epoch) throw new Error("Native Timeline playback command is stale");
    const rollbackSnapshot = acceptedPlaybackRef.current ?? currentPlayback;
    const flight = createTimelinePlaybackCommandFlight(
      ++playbackFlightIdRef.current,
      acceptedPlaybackGenerationRef.current,
      command,
      epoch,
      rollbackSnapshot,
    );
    playbackFlightRef.current = flight;
    try {
      await dispatchPlayback(command, epoch, flight.requestId);
    } catch (error) {
      if (shouldRollbackTimelinePlaybackCommand(
        flight,
        playbackFlightRef.current,
        acceptedPlaybackGenerationRef.current,
        acceptedPlaybackRef.current,
      )) {
        playbackFlightRef.current = null;
        nativePlaybackRef.current = flight.rollbackSnapshot;
        notifyPlaybackListeners();
        reportTimelinePlaybackCommandFailure(error);
      }
      throw error;
    }
  }, [dispatchPlayback, notifyPlaybackListeners]);

  useEffect(() => {
    if (!runtime) return;
    let disposed = false;
    const deliveryAges: number[] = [];
    const sampleToEmitAges: number[] = [];
    const emitToListenerAges: number[] = [];
    const eventIntervals: number[] = [];
    let previousReceivedAt: number | undefined;
    let previousEventSequence: number | undefined;
    let previousSnapshotRevision: number | undefined;
    let eventSequenceGaps = 0;
    let revisionGaps = 0;
    const measurementStartedAt = performance.now();
    const sampleTarget = import.meta.env.VITE_TIMELINE_PLAYBACK_SYNC_SELF_TEST ? 100 : 0;
    const markNativeUnavailable = (error: unknown) => {
      if (disposed) return;
      reportTimelineDiagnostic("error", `Native Timeline playback unavailable: ${safeDiagnosticText(error)}`);
      const current = playbackConnectionRef.current;
      const latestRevision = current.kind === "native-loading" || current.kind === "native-unavailable"
        ? current.latestRevision
        : current.kind === "native-available" ? current.latestRevision : 0;
      const next: PlaybackConnectionState = {
        kind: "native-unavailable",
        latestEpoch: Math.max(1, nativePlaybackEpochRef.current),
        latestRevision,
      };
      playbackConnectionRef.current = next;
      nativePlaybackRef.current = null;
      setPlaybackConnection(next);
      notifyPlaybackListeners();
    };

    const applySnapshot = (snapshot: TimelinePlaybackSnapshot, measure: boolean) => {
      if (disposed || snapshot.epoch < nativePlaybackEpochRef.current) return;
      nativePlaybackEpochRef.current = snapshot.epoch;
      const measureEvent = measure && sampleTarget > 0 && deliveryAges.length < sampleTarget;
      if (measureEvent) {
        eventSequenceGaps += timelineSequenceGap(previousEventSequence, snapshot.eventSequence);
        previousEventSequence = snapshot.eventSequence;
      }
      const currentConnection = playbackConnectionRef.current;
      const acceptance = acceptPlaybackSnapshot(currentConnection, snapshot);
      if (!acceptance.accepted) return;
      const currentAcceptedGeneration = acceptedPlaybackGenerationRef.current;
      const currentFlight = playbackFlightRef.current;
      const freshResults = snapshot.commandResults.filter(
        (result) => result.sequence > lastCommandResultSequenceRef.current,
      );
      if (snapshot.commandResults.length > 0) {
        lastCommandResultSequenceRef.current = Math.max(
          lastCommandResultSequenceRef.current,
          snapshot.commandResults[snapshot.commandResults.length - 1].sequence,
        );
      }
      const rejectedFlight = currentFlight && freshResults.find(
        (result) => !result.applied && timelinePlaybackCommandResultMatchesFlight(
          result,
          currentFlight,
          currentAcceptedGeneration,
        ),
      );
      acceptedPlaybackGenerationRef.current += 1;
      acceptedPlaybackRef.current = snapshot.available ? snapshot : null;
      playbackFlightRef.current = null;
      nativePlaybackRef.current = snapshot.available ? snapshot : null;
      const nextConnection = acceptance.state;
      playbackConnectionRef.current = nextConnection;
      setPlaybackConnection(nextConnection);

      if (rejectedFlight && currentFlight && snapshot.available && currentFlight.rollbackSnapshot.available) {
        nativePlaybackRef.current = {
          ...currentFlight.rollbackSnapshot,
          commandResults: snapshot.commandResults,
        };
        reportTimelinePlaybackCommandFailure(rejectedFlight.error ?? "unknown error");
      }
      notifyPlaybackListeners();

      if (!measureEvent) return;
      const receivedAt = performance.now();
      const ages = timelineEventAges(snapshot);
      deliveryAges.push(ages.totalDeliveryAgeMs);
      sampleToEmitAges.push(ages.sampleToEmitAgeMs);
      emitToListenerAges.push(ages.emitToListenerAgeMs);
      revisionGaps += timelineSequenceGap(previousSnapshotRevision, snapshot.revision);
      previousSnapshotRevision = snapshot.revision;
      if (previousReceivedAt !== undefined) eventIntervals.push(receivedAt - previousReceivedAt);
      previousReceivedAt = receivedAt;
      if (deliveryAges.length !== sampleTarget) return;
      const orderedAges = [...deliveryAges].sort((left, right) => left - right);
      const p95Index = Math.min(orderedAges.length - 1, Math.ceil(orderedAges.length * 0.95) - 1);
      const ageSum = orderedAges.reduce((total, age) => total + age, 0);
      const orderedSampleToEmitAges = [...sampleToEmitAges].sort((left, right) => left - right);
      const orderedEmitToListenerAges = [...emitToListenerAges].sort((left, right) => left - right);
      const sampleToEmitSum = orderedSampleToEmitAges.reduce((total, age) => total + age, 0);
      const emitToListenerSum = orderedEmitToListenerAges.reduce((total, age) => total + age, 0);
      const intervalSum = eventIntervals.reduce((total, interval) => total + interval, 0);
      void reportTimelineEventPerformance({
        source: "timeline-event",
        sampleCount: orderedAges.length,
        targetIntervalMs: NATIVE_PLAYBACK_EVENT_INTERVAL_MS,
        elapsedMs: performance.now() - measurementStartedAt,
        averageDeliveryAgeMs: ageSum / orderedAges.length,
        p95DeliveryAgeMs: orderedAges[p95Index],
        maxDeliveryAgeMs: orderedAges[orderedAges.length - 1],
        averageSampleToEmitAgeMs: sampleToEmitSum / orderedSampleToEmitAges.length,
        p95SampleToEmitAgeMs: orderedSampleToEmitAges[p95Index],
        maxSampleToEmitAgeMs: orderedSampleToEmitAges[orderedSampleToEmitAges.length - 1],
        averageEmitToListenerAgeMs: emitToListenerSum / orderedEmitToListenerAges.length,
        p95EmitToListenerAgeMs: orderedEmitToListenerAges[p95Index],
        maxEmitToListenerAgeMs: orderedEmitToListenerAges[orderedEmitToListenerAges.length - 1],
        eventSequenceGaps,
        revisionGaps,
        averageEventIntervalMs: intervalSum / eventIntervals.length,
        maxEventIntervalMs: Math.max(...eventIntervals),
      }).catch((error) => {
        if (!disposed) console.warn("[Timeline] failed to report event performance", error);
      });
    };

    const listener = createTimelinePlaybackListener(
      subscribeTimelinePlayback,
      (snapshot) => applySnapshot(snapshot, true),
      markNativeUnavailable,
    );
    void listener.ready
      .then((stopListening) => {
        if (!stopListening || disposed) return null;
        return getTimelinePlayback();
      })
      .then((snapshot) => {
        if (!snapshot || disposed) return;
        applySnapshot(snapshot, false);
      })
      .catch((error) => {
        markNativeUnavailable(error);
      });
    return () => {
      disposed = true;
      listener.dispose();
    };
  }, [notifyPlaybackListeners, runtime]);

  const localDuration = useMemo(() => {
    const range = dataSource.getRange();
    return Math.max(1, Number.isFinite(range.end) ? range.end : 1);
  }, [dataSource, revision]);
  const controllerDuration = runtime ? null : localDuration;
  const playbackController = useMemo(() => {
    if (runtime) {
      return createTimelineEditorPlaybackController({
        getSnapshot: () => nativePlaybackRef.current,
        subscribe: (listener) => {
          playbackListenersRef.current.add(listener);
          return () => playbackListenersRef.current.delete(listener);
        },
        dispatch: dispatchNativeCommand,
      });
    }
    return createLocalPlaybackController(controllerDuration ?? 1);
  }, [controllerDuration, dispatchNativeCommand, runtime]);

  useEffect(() => {
    if (runtime) return;
    return () => stopTimelineEditorPlaybackController(playbackController);
  }, [playbackController, runtime]);

  const playbackSnapshot = useSyncExternalStore(
    playbackController.subscribe,
    playbackController.getSnapshot,
    playbackController.getSnapshot,
  );
  const nativePlayback = playbackConnection.kind === "native-available" ? playbackConnection.snapshot : null;
  const playbackStatus = formatTimelinePlaybackStatus(playbackConnection, playbackSnapshot.playing);

  useEffect(() => {
    if (!import.meta.env.DEV || timelineSelfTestHasRun || !import.meta.env.VITE_TIMELINE_SELF_TEST) return;
    timelineSelfTestHasRun = true;
    let completed = false;
    const timers = createSelfTestTimerBag();
    timers.schedule(() => {
      const zoom = document.querySelector<HTMLInputElement>(".timeline-editor__zoom input");
      if (zoom) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(zoom, "20");
        zoom.dispatchEvent(new Event("input", { bubbles: true }));
        zoom.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, 2000);
    timers.schedule(() => {
      const viewport = document.querySelector<HTMLElement>(".timeline-editor__viewport");
      if (!viewport) {
        timelineSelfTestHasRun = false;
        return;
      }
      viewport.scrollLeft = 1800;
      viewport.scrollTop = 680;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      completed = true;
    }, 4000);
    const unregister = registerTimelineSelfTestCleanup(() => {
      timers.cancel();
      if (!completed) timelineSelfTestHasRun = false;
    });
    return () => {
      unregister();
      timers.cancel();
      if (!completed) timelineSelfTestHasRun = false;
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV || timelinePlaybackSelfTestHasRun || !import.meta.env.VITE_TIMELINE_PLAYBACK_SELF_TEST) return;
    if (!nativePlayback?.available || !nativePlayback.instanceId || nativePlayback.clipIndex === null) return;
    timelinePlaybackSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    const target = resolveTimelinePlaybackTarget(null, nativePlayback);
    if (!target) {
      timelinePlaybackSelfTestHasRun = false;
      timers.cancel();
      return;
    }
    const unregister = registerTimelineSelfTestCleanup(() => {
      timers.cancel();
      if (!completed) timelinePlaybackSelfTestHasRun = false;
    });
    void (async () => {
      try {
        if (timers.isCancelled()) return;
        await dispatchPlayback({ type: "pause", ...target }, nativePlayback.epoch);
        if (!(await timers.delay(150))) return;
        const pausedA = await getTimelinePlayback();
        if (!(await timers.delay(250))) return;
        const pausedB = await getTimelinePlayback();
        const seekTime = nativePlayback.duration * 0.5;
        if (timers.isCancelled()) return;
        await dispatchPlayback({ type: "seek", ...target, time: seekTime }, nativePlayback.epoch);
        if (!(await timers.delay(150))) return;
        const sought = await getTimelinePlayback();
        if (timers.isCancelled()) return;
        await dispatchPlayback({ type: "play", ...target }, nativePlayback.epoch);
        if (!(await timers.delay(300))) return;
        const resumed = await getTimelinePlayback();
        if (timers.isCancelled()) return;
        await dispatchPlayback({ type: "pause", ...target }, nativePlayback.epoch);
        if (!(await timers.delay(150))) return;
        const final = await getTimelinePlayback();
        if (timers.isCancelled()) return;
        const passed =
          !pausedA.playing && !pausedB.playing && Math.abs(pausedB.time - pausedA.time) < 0.02 &&
          !sought.playing && Math.abs(sought.time - seekTime) < 0.05 && resumed.playing &&
          resumed.time > sought.time + 0.1 && !final.playing && final.time >= resumed.time;
        reportTimelineDiagnostic(
          passed ? "info" : "error",
          `${passed ? "PASS" : "FAIL"} Native Timeline pause/seek/play self-test: ${final.time.toFixed(2)}s`,
        );
        completed = true;
      } catch (error) {
        if (!timers.isCancelled()) reportTimelineDiagnostic("error", `FAIL Native Timeline playback self-test: ${safeDiagnosticText(error)}`);
      }
    })();
    return () => {
      unregister();
      timers.cancel();
      if (!completed) timelinePlaybackSelfTestHasRun = false;
    };
  }, [dispatchPlayback, nativePlayback?.available, nativePlayback?.clipIndex, nativePlayback?.epoch, nativePlayback?.instanceId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, select, textarea, [contenteditable=true]")) return;
      if (!runtime || !playbackSnapshot.available || !nativePlaybackRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const snapshot = nativePlaybackRef.current;
      const targetRef = resolveTimelinePlaybackTarget(null, snapshot);
      if (!targetRef) return;
      void dispatchNativeCommand(
        playbackSnapshot.playing ? { type: "pause", ...targetRef } : { type: "play", ...targetRef },
        snapshot.epoch,
      ).catch(() => undefined);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [dispatchNativeCommand, playbackSnapshot.available, playbackSnapshot.playing, runtime]);

  const onDiagnostic = useCallback((diagnostic: { level: "info" | "warning" | "error"; message: string; error?: unknown }) => {
    const level = diagnostic.level === "warning" ? "warn" : diagnostic.level;
    const message = diagnostic.error
      ? `${diagnostic.message}: ${boundedDiagnosticText(diagnostic.error)}`
      : diagnostic.message;
    reportTimelineDiagnostic(level, message);
  }, []);

  const onPerformanceSummary = useCallback((summary: unknown) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("tauri3d:timeline-performance", {
      detail: { source: "timeline", summary },
    }));
  }, []);

  return (
    <section className="timeline-host" aria-label="Timeline playback">
      <span className="timeline-host__status" role="status" aria-live="polite" aria-atomic="true">
        {playbackStatus}
      </span>
      <TimelineEditor
        dataSource={dataSource}
        playbackController={playbackController}
        frameRate={frameRate}
        displayMode={displayMode}
        variant={variant}
        onDiagnostic={onDiagnostic}
        onPerformanceSummary={onPerformanceSummary}
      />
    </section>
  );
}
