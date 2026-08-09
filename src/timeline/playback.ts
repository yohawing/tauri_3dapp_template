import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TimelinePlaybackSnapshot {
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

export function getTimelinePlayback(): Promise<TimelinePlaybackSnapshot> {
  return invoke("get_timeline_playback");
}

export function subscribeTimelinePlayback(
  listener: (snapshot: TimelinePlaybackSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<TimelinePlaybackSnapshot>("timeline-playback-changed", (event) => {
    listener(event.payload);
  });
}

export function dispatchTimelinePlayback(command: TimelinePlaybackCommand): Promise<void> {
  return invoke("dispatch_timeline_playback", { command });
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

export function reportTimelineEventPerformance(
  summary: TimelineEventPerformanceSummary,
): Promise<void> {
  return invoke("report_performance_summary", { summary });
}
