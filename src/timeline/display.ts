export type TimelineDisplayMode = "frames" | "seconds";
export type TimelineSeekPolicy = "unsnapped" | "frame-snap";

export function clampTimelineTime(time: number, timeEnd: number): number {
  const end = Number.isFinite(timeEnd) && timeEnd >= 0 ? timeEnd : 0;
  if (Number.isNaN(time) || time === -Infinity) return 0;
  if (time === Infinity) return end;
  return Math.min(end, Math.max(0, time));
}

/** Explicit editing operation; display formatting never calls this helper. */
export function snapTimelineTimeToFrame(time: number, fps = 24): number {
  if (!Number.isFinite(time)) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return time;
  return Math.round(time * fps) / fps;
}

export function resolveTimelineSeekTime(
  time: number,
  timeEnd: number,
  policy: TimelineSeekPolicy = "unsnapped",
  fps = 24,
): number {
  const clamped = clampTimelineTime(time, timeEnd);
  return policy === "frame-snap"
    ? clampTimelineTime(snapTimelineTimeToFrame(clamped, fps), timeEnd)
    : clamped;
}

export function formatTimelineReadout(
  time: number,
  timeEnd: number,
  displayMode: TimelineDisplayMode,
  fps = 24,
): string {
  const canonical = clampTimelineTime(time, timeEnd);
  if (displayMode === "frames") {
    return `${String(Math.round(canonical * fps)).padStart(4, "0")} / ${String(Math.round(clampTimelineTime(timeEnd, timeEnd) * fps)).padStart(4, "0")}`;
  }
  return `${canonical.toFixed(2)} / ${clampTimelineTime(timeEnd, timeEnd).toFixed(2)} s`;
}

export function formatCompactTimelineReadout(
  time: number,
  timeEnd: number,
  displayMode: TimelineDisplayMode,
  fps = 24,
): string {
  const canonical = clampTimelineTime(time, timeEnd);
  return displayMode === "frames"
    ? `${String(Math.round(canonical * fps)).padStart(4, "0")} f`
    : `${canonical.toFixed(2)} s`;
}

export function formatTimelineTick(time: number, displayMode: TimelineDisplayMode, fps = 24): string {
  return displayMode === "frames"
    ? String(Math.round(time * fps)).padStart(4, "0")
    : `${time.toFixed(1)}s`;
}
