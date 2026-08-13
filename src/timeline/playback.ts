import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TimelinePlaybackTarget } from "./core/contracts";
import { isBoundedUtf8String, isFiniteF32, isSafeNonNegativeInteger, isWireRecord } from "../wireValidation";

export type { TimelinePlaybackTarget } from "./core/contracts";

export type TimelinePlaybackCommandType = "play" | "pause" | "seek" | "setLooping";

export interface TimelinePlaybackCommandResult {
  sequence: number;
  requestId: number;
  epoch: number;
  instanceId: string;
  clipIndex: number;
  commandType: TimelinePlaybackCommandType;
  applied: boolean;
  error: string | null;
}

export interface TimelinePlaybackSnapshot {
  /** Runtime Scene generation; older snapshots/commands are stale after replace. */
  epoch: number;
  revision: number;
  sampledAtUnixMs: number;
  /** Rust wall-clock timestamp captured immediately before event emission. */
  emittedAtUnixMs: number;
  /** Monotonic process-local event sequence; gaps indicate dropped/out-of-order events. */
  eventSequence: number;
  available: boolean;
  instanceId: string | null;
  clipIndex: number | null;
  time: number;
  duration: number;
  playing: boolean;
  looping: boolean;
  commandResults: TimelinePlaybackCommandResult[];
}

const MAX_REQUEST_ID = Number.MAX_SAFE_INTEGER;
const MAX_RUNTIME_ID_LENGTH = 1_024;
let nextPlaybackRequestId = Math.max(1, Math.min(MAX_REQUEST_ID - 1, Date.now() * 1000));

function allocatePlaybackRequestId(): number {
  const requestId = nextPlaybackRequestId;
  nextPlaybackRequestId = requestId >= MAX_REQUEST_ID - 1 ? 1 : requestId + 1;
  return requestId;
}

function isCommandType(value: unknown): value is TimelinePlaybackCommandType {
  return value === "play" || value === "pause" || value === "seek" || value === "setLooping";
}

function normalizeTimelinePlaybackCommandResult(value: unknown): TimelinePlaybackCommandResult | null {
  if (!isWireRecord(value)) return null;
  const sequence = value.sequence;
  const requestId = value.requestId;
  const epoch = value.epoch;
  const instanceId = value.instanceId;
  const clipIndex = value.clipIndex;
  const commandType = value.commandType;
  const applied = value.applied;
  const error = value.error;
  if (
    !isSafeNonNegativeInteger(sequence) || sequence < 1 ||
    !isSafeNonNegativeInteger(requestId) || requestId < 1 || requestId > MAX_REQUEST_ID ||
    !isSafeNonNegativeInteger(epoch) || epoch < 1 ||
    !isBoundedUtf8String(instanceId, MAX_RUNTIME_ID_LENGTH) ||
    !isSafeNonNegativeInteger(clipIndex) ||
    !isCommandType(commandType) ||
    typeof applied !== "boolean" ||
    (error !== null && !isBoundedUtf8String(error, 4_096, true))
  ) {
    return null;
  }
  return { sequence, requestId, epoch, instanceId, clipIndex, commandType, applied, error };
}

/** Reject malformed Native playback snapshots before they affect Timeline state. */
export function normalizeTimelinePlaybackSnapshot(value: unknown): TimelinePlaybackSnapshot | null {
  if (!isWireRecord(value)) return null;
  const epoch = value.epoch;
  const revision = value.revision;
  const sampledAtUnixMs = value.sampledAtUnixMs;
  const emittedAtUnixMs = value.emittedAtUnixMs;
  const eventSequence = value.eventSequence;
  const available = value.available;
  const instanceId = value.instanceId;
  const clipIndex = value.clipIndex;
  const time = value.time;
  const duration = value.duration;
  const playing = value.playing;
  const looping = value.looping;
  const commandResults = value.commandResults;
  if (
    !isSafeNonNegativeInteger(epoch) || epoch < 1 ||
    !isSafeNonNegativeInteger(revision) ||
    !isSafeNonNegativeInteger(sampledAtUnixMs) ||
    !isSafeNonNegativeInteger(emittedAtUnixMs) ||
    !isSafeNonNegativeInteger(eventSequence) ||
    typeof available !== "boolean" ||
    (instanceId !== null && !isBoundedUtf8String(instanceId, MAX_RUNTIME_ID_LENGTH)) ||
    (clipIndex !== null && !isSafeNonNegativeInteger(clipIndex)) ||
    !isFiniteF32(time) || time < 0 ||
    !isFiniteF32(duration) || duration < 0 ||
    typeof playing !== "boolean" ||
    typeof looping !== "boolean" ||
    !Array.isArray(commandResults) || commandResults.length > 32
  ) {
    return null;
  }
  const normalizedCommandResults: TimelinePlaybackCommandResult[] = [];
  let previousResultSequence = 0;
  for (const result of commandResults) {
    const normalized = normalizeTimelinePlaybackCommandResult(result);
    if (!normalized || normalized.sequence <= previousResultSequence || normalized.epoch !== epoch) {
      return null;
    }
    previousResultSequence = normalized.sequence;
    normalizedCommandResults.push(normalized);
  }
  if (!available) {
    if (instanceId !== null || clipIndex !== null || time !== 0 || duration !== 0 || playing || looping) {
      return null;
    }
  } else if (
    instanceId === null || !isBoundedUtf8String(instanceId, MAX_RUNTIME_ID_LENGTH) ||
    clipIndex === null || time > duration
  ) {
    return null;
  }
  return {
    epoch,
    revision,
    sampledAtUnixMs,
    emittedAtUnixMs,
    eventSequence,
    available,
    instanceId,
    clipIndex,
    time,
    duration,
    playing,
    looping,
    commandResults: normalizedCommandResults,
  };
}

function requireTimelinePlaybackSnapshot(value: unknown): TimelinePlaybackSnapshot {
  const snapshot = normalizeTimelinePlaybackSnapshot(value);
  if (!snapshot) throw new Error("Invalid timeline playback snapshot payload");
  return snapshot;
}

export interface TimelineEventAges {
  sampleToEmitAgeMs: number;
  emitToListenerAgeMs: number;
  totalDeliveryAgeMs: number;
}

/**
 * Split event latency using the shared Unix-ms clock. Negative values are clamped so
 * small wall-clock adjustments cannot produce misleading negative ages.
 */
export function timelineEventAges(
  snapshot: TimelinePlaybackSnapshot,
  receivedAtUnixMs = Date.now(),
): TimelineEventAges {
  const sampleToEmitAgeMs = Math.max(0, snapshot.emittedAtUnixMs - snapshot.sampledAtUnixMs);
  const emitToListenerAgeMs = Math.max(0, receivedAtUnixMs - snapshot.emittedAtUnixMs);
  return {
    sampleToEmitAgeMs,
    emitToListenerAgeMs,
    totalDeliveryAgeMs: sampleToEmitAgeMs + emitToListenerAgeMs,
  };
}

/** Count missing or out-of-order values in a monotonic sequence. */
export function timelineSequenceGap(previous: number | undefined, current: number): number {
  if (previous === undefined) return 0;
  const delta = current - previous;
  return delta > 1 ? delta - 1 : delta < 1 ? 1 : 0;
}

export type TimelinePlaybackCommand =
  | { type: "play"; instanceId: string; clipIndex: number }
  | { type: "pause"; instanceId: string; clipIndex: number }
  | { type: "seek"; instanceId: string; clipIndex: number; time: number }
  | { type: "setLooping"; instanceId: string; clipIndex: number; looping: boolean };

export interface TimelinePlaybackCommandEnvelope {
  epoch: number;
  requestId: number;
  command: TimelinePlaybackCommand;
}

export interface TimelinePlaybackCommandFlight {
  id: number;
  requestId: number;
  acceptedGeneration: number;
  epoch: number;
  command: TimelinePlaybackCommand;
  rollbackSnapshot: TimelinePlaybackSnapshot;
}

export function timelinePlaybackCommandType(
  command: TimelinePlaybackCommand,
): TimelinePlaybackCommandType {
  return command.type;
}

export function timelinePlaybackCommandResultMatchesFlight(
  result: TimelinePlaybackCommandResult,
  flight: TimelinePlaybackCommandFlight,
  acceptedGeneration: number,
): boolean {
  return (
    flight.acceptedGeneration === acceptedGeneration &&
    result.requestId === flight.requestId &&
    result.epoch === flight.epoch &&
    result.instanceId === flight.command.instanceId &&
    result.clipIndex === flight.command.clipIndex &&
    result.commandType === timelinePlaybackCommandType(flight.command)
  );
}

export function timelinePlaybackTargetEquals(
  left: TimelinePlaybackTarget | null | undefined,
  right: TimelinePlaybackTarget | null | undefined,
): boolean {
  return left?.instanceId === right?.instanceId && left?.clipIndex === right?.clipIndex;
}

export function resolveTimelinePlaybackTarget(
  selectedTarget: TimelinePlaybackTarget | null,
  snapshot: TimelinePlaybackSnapshot | null,
): TimelinePlaybackTarget | null {
  if (selectedTarget) return selectedTarget;
  const instanceId = snapshot?.instanceId;
  const clipIndex = snapshot?.clipIndex;
  if (
    snapshot?.available &&
    typeof instanceId === "string" &&
    instanceId.length > 0 &&
    typeof clipIndex === "number" &&
    Number.isInteger(clipIndex) &&
    clipIndex >= 0
  ) {
    return { instanceId, clipIndex };
  }
  return null;
}

export function createTimelinePlaybackCommandFlight(
  id: number,
  acceptedGeneration: number,
  command: TimelinePlaybackCommand,
  epoch: number,
  rollbackSnapshot: TimelinePlaybackSnapshot,
  requestId = allocatePlaybackRequestId(),
): TimelinePlaybackCommandFlight {
  return { id, requestId, acceptedGeneration, command, epoch, rollbackSnapshot };
}

export function shouldRollbackTimelinePlaybackCommand(
  flight: TimelinePlaybackCommandFlight,
  currentFlight: TimelinePlaybackCommandFlight | null,
  currentAcceptedGeneration: number,
  currentAcceptedSnapshot: TimelinePlaybackSnapshot | null,
): boolean {
  return (
    currentFlight?.id === flight.id &&
    currentAcceptedGeneration === flight.acceptedGeneration &&
    currentAcceptedSnapshot?.epoch === flight.epoch &&
    currentAcceptedSnapshot.revision === flight.rollbackSnapshot.revision
  );
}

export function createTimelinePlaybackCommandEnvelope(
  command: TimelinePlaybackCommand,
  epoch: number,
  requestId = allocatePlaybackRequestId(),
): TimelinePlaybackCommandEnvelope {
  return { epoch, requestId, command };
}

export function getTimelinePlayback(): Promise<TimelinePlaybackSnapshot> {
  return invoke<unknown>("get_timeline_playback").then(requireTimelinePlaybackSnapshot);
}

export function subscribeTimelinePlayback(
  listener: (snapshot: TimelinePlaybackSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<unknown>("timeline-playback-changed", (event) => {
    const snapshot = normalizeTimelinePlaybackSnapshot(event.payload);
    if (snapshot) listener(snapshot);
  });
}

/** Owns an async Tauri listener install and makes late cleanup deterministic. */
export function createTimelinePlaybackListener(
  subscribe: (listener: (snapshot: TimelinePlaybackSnapshot) => void) => Promise<UnlistenFn>,
  listener: (snapshot: TimelinePlaybackSnapshot) => void,
  onError: (error: unknown) => void,
) {
  let disposed = false;
  let unlisten: UnlistenFn | undefined;

  const safelyUnlisten = (stop: UnlistenFn) => {
    try {
      const result = (stop as () => unknown)();
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        void (result as PromiseLike<void>).then(undefined, (error) => {
          if (!disposed) onError(error);
        });
      }
    } catch (error) {
      if (!disposed) onError(error);
    }
  };

  const guardedListener = (snapshot: TimelinePlaybackSnapshot): void => {
    if (!disposed) listener(snapshot);
  };
  const ready = subscribe(guardedListener).then(
    (stop) => {
      if (disposed) {
        safelyUnlisten(stop);
        return null;
      }
      unlisten = stop;
      return stop;
    },
    (error) => {
      if (!disposed) onError(error);
      return null;
    },
  );

  return {
    ready,
    dispose: () => {
      disposed = true;
      const stop = unlisten;
      unlisten = undefined;
      if (stop) safelyUnlisten(stop);
    },
  };
}

export function dispatchTimelinePlayback(
  command: TimelinePlaybackCommand,
  epoch: number,
  requestId = allocatePlaybackRequestId(),
): Promise<void> {
  return invoke("dispatch_timeline_playback", {
    command: createTimelinePlaybackCommandEnvelope(command, epoch, requestId),
  });
}

export type TimelinePlaybackDispatch = (
  command: TimelinePlaybackCommand,
  epoch: number,
  requestId?: number,
) => Promise<void>;

interface PendingPlaybackCommand {
  command: TimelinePlaybackCommand;
  epoch: number;
  requestId: number;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

const MAX_PENDING_PLAYBACK_COMMANDS = 256;

function isSameSeekTarget(
  left: PendingPlaybackCommand,
  command: TimelinePlaybackCommand,
  epoch: number,
): boolean {
  return (
    left.epoch === epoch &&
    left.command.type === "seek" &&
    command.type === "seek" &&
    left.command.instanceId === command.instanceId &&
    left.command.clipIndex === command.clipIndex
  );
}

/**
 * Serializes playback IPC, coalesces only adjacent same-target seeks, and
 * rejects new commands after 256 queued transport-boundary commands.
 */
export function createTimelinePlaybackDispatcher(
  dependency: TimelinePlaybackDispatch = dispatchTimelinePlayback,
) {
  let inFlight = false;
  let active: PendingPlaybackCommand | null = null;
  let drainGeneration = 0;
  let queue: PendingPlaybackCommand[] = [];
  let disposed = false;
  let latestEpoch = -Infinity;

  const drain = async () => {
    if (inFlight || disposed) return;
    const next = queue.shift();
    if (!next) return;
    const generation = drainGeneration;
    active = next;
    inFlight = true;
    try {
      await dependency(next.command, next.epoch, next.requestId);
      next.waiters.forEach(({ resolve }) => resolve());
    } catch (error) {
      next.waiters.forEach(({ reject }) => reject(error));
    } finally {
      if (generation !== drainGeneration) return;
      active = null;
      inFlight = false;
      if (!disposed) void drain();
    }
  };

  const dispatch = (
    command: TimelinePlaybackCommand,
    epoch: number,
    requestId = allocatePlaybackRequestId(),
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (epoch < latestEpoch) return Promise.resolve();
    if (epoch > latestEpoch) {
      latestEpoch = epoch;
      drainGeneration += 1;
      if (active) {
        active.waiters.forEach(({ resolve }) => resolve());
        active.waiters = [];
        active = null;
        inFlight = false;
      }
      queue.forEach(({ waiters }) => waiters.forEach(({ resolve }) => resolve()));
      queue = [];
    }
    return new Promise<void>((resolve, reject) => {
      const last = queue[queue.length - 1];
      if (last && isSameSeekTarget(last, command, epoch)) {
        // Only the newest seek reaches the transport. Older callers observe
        // superseded completion immediately, keeping waiters bounded while a
        // stalled invoke holds the queue.
        last.waiters.forEach(({ resolve }) => resolve());
        last.command = command;
        last.requestId = requestId;
        last.waiters = [{ resolve, reject }];
      } else {
        if (queue.length >= MAX_PENDING_PLAYBACK_COMMANDS) {
          reject(new Error("timeline playback queue is full; command was rejected"));
          return;
        }
        queue.push({ command, epoch, requestId, waiters: [{ resolve, reject }] });
      }
      void drain();
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    drainGeneration += 1;
    if (active) {
      active.waiters.forEach(({ resolve }) => resolve());
      active.waiters = [];
      active = null;
      inFlight = false;
    }
    queue.forEach(({ waiters }) => waiters.forEach(({ resolve }) => resolve()));
    queue = [];
  };

  return { dispatch, dispose };
}

export function projectTimelinePlaybackTime(
  snapshot: TimelinePlaybackSnapshot,
  nowUnixMs = Date.now(),
): number {
  if (!snapshot.playing || snapshot.duration <= 0) return snapshot.time;
  const elapsedSeconds = Math.max(0, nowUnixMs - snapshot.sampledAtUnixMs) / 1000;
  const projected = snapshot.time + elapsedSeconds;
  if (snapshot.looping) return projected % snapshot.duration;
  return Math.min(projected, snapshot.duration);
}

export interface TimelineEventPerformanceSummary {
  source: "timeline-event";
  sampleCount: number;
  targetIntervalMs: number;
  elapsedMs: number;
  averageDeliveryAgeMs: number;
  p95DeliveryAgeMs: number;
  maxDeliveryAgeMs: number;
  averageSampleToEmitAgeMs: number;
  p95SampleToEmitAgeMs: number;
  maxSampleToEmitAgeMs: number;
  averageEmitToListenerAgeMs: number;
  p95EmitToListenerAgeMs: number;
  maxEmitToListenerAgeMs: number;
  eventSequenceGaps: number;
  revisionGaps: number;
  averageEventIntervalMs: number;
  maxEventIntervalMs: number;
}

const timelinePerformanceNonNegativeFields = [
  "elapsedMs",
  "averageDeliveryAgeMs",
  "p95DeliveryAgeMs",
  "maxDeliveryAgeMs",
  "averageSampleToEmitAgeMs",
  "p95SampleToEmitAgeMs",
  "maxSampleToEmitAgeMs",
  "averageEmitToListenerAgeMs",
  "p95EmitToListenerAgeMs",
  "maxEmitToListenerAgeMs",
  "averageEventIntervalMs",
  "maxEventIntervalMs",
] as const satisfies readonly (keyof TimelineEventPerformanceSummary)[];

function normalizeTimelineEventPerformanceSummary(
  value: unknown,
): TimelineEventPerformanceSummary | null {
  if (!isWireRecord(value) || value.source !== "timeline-event") return null;
  const sampleCount = value.sampleCount;
  const targetIntervalMs = value.targetIntervalMs;
  const eventSequenceGaps = value.eventSequenceGaps;
  const revisionGaps = value.revisionGaps;
  if (
    !isSafeNonNegativeInteger(sampleCount) || sampleCount < 1 ||
    !isFiniteF32(targetIntervalMs) || targetIntervalMs <= 0 ||
    !isSafeNonNegativeInteger(eventSequenceGaps) ||
    !isSafeNonNegativeInteger(revisionGaps) ||
    timelinePerformanceNonNegativeFields.some((field) => {
      const metric = value[field];
      return !isFiniteF32(metric) || metric < 0;
    })
  ) return null;

  // Rebuild the fixed wire shape so unknown properties cannot inflate the
  // Value payload beyond the native 64 KiB report limit.
  return {
    source: "timeline-event",
    sampleCount,
    targetIntervalMs,
    elapsedMs: value.elapsedMs as number,
    averageDeliveryAgeMs: value.averageDeliveryAgeMs as number,
    p95DeliveryAgeMs: value.p95DeliveryAgeMs as number,
    maxDeliveryAgeMs: value.maxDeliveryAgeMs as number,
    averageSampleToEmitAgeMs: value.averageSampleToEmitAgeMs as number,
    p95SampleToEmitAgeMs: value.p95SampleToEmitAgeMs as number,
    maxSampleToEmitAgeMs: value.maxSampleToEmitAgeMs as number,
    averageEmitToListenerAgeMs: value.averageEmitToListenerAgeMs as number,
    p95EmitToListenerAgeMs: value.p95EmitToListenerAgeMs as number,
    maxEmitToListenerAgeMs: value.maxEmitToListenerAgeMs as number,
    eventSequenceGaps,
    revisionGaps,
    averageEventIntervalMs: value.averageEventIntervalMs as number,
    maxEventIntervalMs: value.maxEventIntervalMs as number,
  };
}

export function reportTimelineEventPerformance(
  summary: TimelineEventPerformanceSummary,
  report: (summary: TimelineEventPerformanceSummary) => unknown = (value) =>
    invoke("report_performance_summary", { summary: value }),
): Promise<void> {
  // Defer invocation so a synchronous runtime/serialization throw becomes a
  // rejected Promise for callers' existing error boundary.
  return Promise.resolve().then(() => {
    const normalized = normalizeTimelineEventPerformanceSummary(summary);
    if (!normalized) throw new Error("Invalid timeline performance summary");
    return report(normalized);
  }).then(() => undefined);
}
