import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TimelinePlaybackSnapshot {
  revision: number;
  sampledAtUnixMs: number;
  available: boolean;
  instanceId: string | null;
  clipIndex: number | null;
  time: number;
  duration: number;
  playing: boolean;
  looping: boolean;
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
  averageEventIntervalMs: number;
  maxEventIntervalMs: number;
}

export function reportTimelineEventPerformance(
  summary: TimelineEventPerformanceSummary,
): Promise<void> {
  return invoke("report_performance_summary", { summary });
}
