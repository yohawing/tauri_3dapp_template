import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent } from "react";
import { boundedDiagnosticText, safeDiagnosticText } from "../console/contracts";
import { createSelfTestTimerBag } from "../selfTestTimers";
import { CompactNumberInput } from "../components/controls/CompactControls";
import { RangeViewport, type RangeViewportValue } from "../components/controls/RangeViewport";
import { runtimeTimelineDataSource } from "../timeline/adapters/gltfProjectionDataSource";
import {
  createViewTransform,
  type TimelineDataSource,
  type TimelineItem,
  type TimelineKey,
  type TimelineKeyColumn,
  type TimelinePlaybackTarget,
  type TimelineRow,
  type RowRangeQuery,
} from "../timeline/core/contracts";
import {
  createTimelinePlaybackDispatcher,
  createTimelinePlaybackListener,
  getTimelinePlayback,
  projectTimelinePlaybackTime,
  reportTimelineEventPerformance,
  resolveTimelinePlaybackTarget,
  subscribeTimelinePlayback,
  timelinePlaybackTargetEquals,
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
  playbackControlsEnabled,
  type PlaybackConnectionState,
} from "../timeline/playbackState";
import {
  clampTimelineTime,
  formatCompactTimelineReadout,
  formatTimelineReadout,
  formatTimelineTick,
  resolveTimelineSeekTime,
  type TimelineDisplayMode,
  type TimelineSeekPolicy,
} from "../timeline/display";
import { focusLazyPanelHost } from "../components/LazyPanelBoundary";
import "./Timeline.css";

const ROW_HEIGHT = 26;
const MIN_PIXELS_PER_SECOND = 12;
const MAX_PIXELS_PER_SECOND = 180;
const ZOOM_NAVIGATOR_BASE = 30;
const PLAYHEAD_TIME = 4.55;
const TIMELINE_FPS = 24;
const NATIVE_PLAYBACK_EVENT_INTERVAL_MS = 250;
const MAX_VISIBLE_TIMELINE_TICKS = 512;
let timelineSelfTestHasRun = false;
let timelinePlaybackSelfTestHasRun = false;
const activeTimelineSelfTestCleanups = new Set<() => void>();

/** Keep a rejected native transport command visible after optimistic rollback. */
function reportTimelinePlaybackCommandFailure(error: unknown): void {
  const message = `Native playback command failed; rolled back: ${boundedDiagnosticText(error)}`;
  try {
    console.warn("[Timeline]", message);
  } catch {
    // Embedding hosts may replace console methods with throwing shims.
  }
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("tauri3d:diagnostic", {
      detail: { level: "error", source: "timeline", message },
    }));
    window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }));
  } catch {
    // Rollback already restored the native snapshot; diagnostics are best effort.
  }
}

function registerTimelineSelfTestCleanup(cleanup: () => void): () => void {
  activeTimelineSelfTestCleanups.add(cleanup);
  return () => activeTimelineSelfTestCleanups.delete(cleanup);
}

// HMR can replace this module without first unmounting the current React tree.
// Stop old scripted timers before a replacement module arms a second run.
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

/** Return the row page needed to paint the current viewport, including one row of overscan. */
export function visibleTimelineRowQuery(
  rowCount: number,
  viewportTop: number,
  viewportHeight: number,
  rowHeight = ROW_HEIGHT,
): RowRangeQuery {
  const total = Number.isFinite(rowCount) ? Math.max(0, Math.floor(rowCount)) : 0;
  const top = Number.isFinite(viewportTop) ? Math.max(0, viewportTop) : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const safeRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : ROW_HEIGHT;
  const start = Math.min(total, Math.floor(top / safeRowHeight));
  const end = Math.min(total, Math.ceil((top + height) / safeRowHeight) + 1);
  return { start, count: Math.max(0, end - start) };
}

/** Return only the ruler ticks intersecting the horizontal viewport. */
export function visibleTimelineTicks(
  timeEnd: number,
  scrollLeft: number,
  viewportWidth: number,
  pixelsPerSecond: number,
  tickStep: number,
  overscanTicks = 2,
): number[] {
  const end = Number.isFinite(timeEnd) ? Math.max(0, timeEnd) : 0;
  const scale = Number.isFinite(pixelsPerSecond) ? Math.max(0.001, pixelsPerSecond) : 1;
  const step = Number.isFinite(tickStep) ? Math.max(0.001, tickStep) : 1;
  const left = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0;
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const overscan = Number.isFinite(overscanTicks) ? Math.max(0, Math.floor(overscanTicks)) : 0;
  const maxIndex = Math.floor(end / step);
  const maxScroll = Math.max(0, end * scale - width);
  const visibleLeft = Math.min(left, maxScroll);
  const visibleRight = Math.min(end, (visibleLeft + width) / scale);
  const firstIndex = Math.max(0, Math.floor((visibleLeft / scale) / step) - overscan);
  const lastIndex = Math.min(maxIndex, Math.ceil(visibleRight / step) + overscan);
  const count = Math.min(MAX_VISIBLE_TIMELINE_TICKS, Math.max(0, lastIndex - firstIndex + 1));
  return Array.from({ length: count }, (_, offset) => (firstIndex + offset) * step);
}

function isTimelineTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, select, textarea")) return true;
  let current: Element | null = target;
  while (current) {
    if (current instanceof HTMLElement && current.isContentEditable) return true;
    current = current.parentElement;
  }
  return false;
}

function LoopIcon() {
  return (
    <svg className="timeline-control-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 5h7.5a2.5 2.5 0 0 1 2.5 2.5V9" />
      <path d="m10.5 6 2.5 2.5L15.5 6" />
      <path d="M13 11H5.5A2.5 2.5 0 0 1 3 8.5V7" />
      <path d="m5.5 10-2.5-2.5L.5 10" />
    </svg>
  );
}

function pixelsPerSecondFromZoomRange(range: RangeViewportValue) {
  const width = Math.max(1, range.end - range.start) / 100;
  return Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, ZOOM_NAVIGATOR_BASE / width));
}

interface TimelineProps {
  dataSource?: TimelineDataSource;
  variant?: "compact" | "full";
}

interface CanvasWindow {
  left: number;
  top: number;
  width: number;
  height: number;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawDiamond(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x, y - radius);
  context.lineTo(x + radius, y);
  context.lineTo(x, y + radius);
  context.lineTo(x - radius, y);
  context.closePath();
}

function drawItem(
  context: CanvasRenderingContext2D,
  item: TimelineItem,
  rowIndex: number,
  timeToX: (time: number) => number,
) {
  const rowY = rowIndex * ROW_HEIGHT;

  if (item.kind === "clip") {
    const x = timeToX(item.range.start);
    const width = Math.max(3, timeToX(item.range.end) - x);
    roundedRect(context, x + 1, rowY + 4, width - 2, 18, 3);
    context.fillStyle = item.color;
    context.globalAlpha = 0.82;
    context.fill();
    context.globalAlpha = 1;

    if (item.selected) {
      context.strokeStyle = "#e8eaff";
      context.lineWidth = 1.5;
      context.stroke();
    } else {
      context.strokeStyle = "rgba(255, 255, 255, 0.16)";
      context.lineWidth = 1;
      context.stroke();
    }

    context.save();
    context.beginPath();
    context.rect(x + 7, rowY + 4, Math.max(0, width - 14), 18);
    context.clip();
    context.fillStyle = "rgba(255, 255, 255, 0.9)";
    context.font = "500 10px Inter, Segoe UI, sans-serif";
    context.textBaseline = "middle";
    context.fillText(item.label, x + 8, rowY + 13);

    if (item.rowId === "row-audio") {
      context.strokeStyle = "rgba(218, 255, 244, 0.44)";
      context.lineWidth = 1;
      context.beginPath();
      for (let offset = 0; offset < width - 12; offset += 4) {
        const amplitude = 2 + Math.abs(Math.sin(offset * 0.17)) * 3;
        context.moveTo(x + 7 + offset, rowY + 13 - amplitude);
        context.lineTo(x + 7 + offset, rowY + 13 + amplitude);
      }
      context.stroke();
    }
    context.restore();
    return;
  }

  const x = timeToX(item.time);
  if (item.kind === "marker") {
    context.strokeStyle = item.color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x + 0.5, rowY + 7);
    context.lineTo(x + 0.5, rowY + 22);
    context.stroke();
    context.fillStyle = item.color;
    context.beginPath();
    context.moveTo(x - 5, rowY + 5);
    context.lineTo(x + 5, rowY + 5);
    context.lineTo(x, rowY + 11);
    context.closePath();
    context.fill();
  } else if (item.kind === "event-cue") {
    context.fillStyle = item.color;
    context.beginPath();
    context.moveTo(x, rowY + 5);
    context.lineTo(x + 6, rowY + 9);
    context.lineTo(x + 6, rowY + 17);
    context.lineTo(x, rowY + 21);
    context.lineTo(x - 6, rowY + 17);
    context.lineTo(x - 6, rowY + 9);
    context.closePath();
    context.fill();
  } else {
    context.fillStyle = item.color;
    context.beginPath();
    context.arc(x, rowY + 13, 5, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "rgba(238, 238, 244, 0.78)";
  context.font = "500 9px Inter, Segoe UI, sans-serif";
  context.textBaseline = "middle";
  context.fillText(item.label, x + 9, rowY + 13);
}

function drawKey(
  context: CanvasRenderingContext2D,
  key: TimelineKey,
  rowIndex: number,
  timeToX: (time: number) => number,
) {
  const x = timeToX(key.time);
  const y = rowIndex * ROW_HEIGHT + 19;
  drawDiamond(context, x, y, key.selected ? 4.5 : 3.5);
  context.fillStyle = key.selected ? "#ffffff" : "rgba(230, 232, 255, 0.78)";
  context.fill();
  context.strokeStyle = "rgba(24, 24, 31, 0.9)";
  context.lineWidth = 1;
  context.stroke();
}

function drawKeyColumn(
  context: CanvasRenderingContext2D,
  column: TimelineKeyColumn,
  rowIndex: number,
  timeToX: (time: number) => number,
) {
  if (column.count === 1) {
    drawKey(
      context,
      {
        kind: "key",
        id: `aggregate:${column.channelId}:${column.time}` as TimelineKey["id"],
        rowId: column.rowId,
        channelId: column.channelId,
        time: column.time,
      },
      rowIndex,
      timeToX,
    );
    return;
  }
  const x = Math.round(timeToX(column.time)) + 0.5;
  const y = rowIndex * ROW_HEIGHT + 13;
  context.strokeStyle = `rgba(230, 232, 255, ${Math.min(1, 0.3 + Math.log2(column.count) / 8)})`;
  context.lineWidth = Math.min(4, 1 + Math.log2(column.count) / 3);
  context.beginPath();
  context.moveTo(x, y - 9);
  context.lineTo(x, y + 9);
  context.stroke();
}

function paintTimeline(
  canvas: HTMLCanvasElement,
  rows: readonly TimelineRow[],
  rowStart: number,
  items: readonly TimelineItem[],
  keys: readonly TimelineKey[],
  keyColumns: readonly TimelineKeyColumn[],
  pixelsPerSecond: number,
  timeEnd: number,
  viewport: CanvasWindow,
  range: { enabled: boolean; start: number; end: number },
) {
  const canvasWidth = Math.max(1, viewport.width);
  const canvasHeight = Math.max(1, viewport.height);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvasWidth * dpr);
  canvas.height = Math.round(canvasHeight * dpr);
  canvas.style.width = `${canvasWidth}px`;
  canvas.style.height = `${canvasHeight}px`;
  canvas.style.transform = `translate3d(${viewport.left}px, ${viewport.top}px, 0)`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.translate(-viewport.left, -viewport.top);

  const firstRow = Math.max(rowStart, Math.floor(viewport.top / ROW_HEIGHT));
  const lastRow = Math.min(
    rowStart + rows.length,
    Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT),
  );
  for (let index = firstRow; index < lastRow; index += 1) {
    const row = rows[index - rowStart];
    if (!row) continue;
    const y = index * ROW_HEIGHT;
    context.fillStyle =
      row.kind === "group"
        ? "#22242d"
        : index % 2 === 0
          ? "#1c1e25"
          : "#191b21";
    context.fillRect(viewport.left, y, viewport.width, ROW_HEIGHT);
    context.strokeStyle = "rgba(255, 255, 255, 0.055)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(viewport.left, y + ROW_HEIGHT - 0.5);
    context.lineTo(viewport.left + viewport.width, y + ROW_HEIGHT - 0.5);
    context.stroke();
  }

  const gridStep = pixelsPerSecond >= 40 ? 0.5 : pixelsPerSecond >= 15 ? 1 : 5;
  const firstGridTime = Math.max(0, Math.floor(viewport.left / pixelsPerSecond / gridStep) * gridStep);
  const lastGridTime = Math.min(timeEnd, (viewport.left + viewport.width) / pixelsPerSecond);
  for (let time = firstGridTime; time <= lastGridTime; time += gridStep) {
    const x = time * pixelsPerSecond + 0.5;
    const major = Number.isInteger(time);
    context.strokeStyle = major
      ? "rgba(255, 255, 255, 0.105)"
      : "rgba(255, 255, 255, 0.045)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, viewport.top);
    context.lineTo(x, viewport.top + viewport.height);
    context.stroke();
  }

  const transform = createViewTransform(0, pixelsPerSecond);
  const rowIndexById = new Map(rows.map((row, index) => [row.id, rowStart + index]));
  for (const item of items) {
    const rowIndex = rowIndexById.get(item.rowId);
    if (rowIndex != null && rowIndex >= firstRow && rowIndex < lastRow) {
      drawItem(context, item, rowIndex, transform.timeToX);
    }
  }
  for (const key of keys) {
    const rowIndex = rowIndexById.get(key.rowId);
    if (rowIndex != null && rowIndex >= firstRow && rowIndex < lastRow) {
      drawKey(context, key, rowIndex, transform.timeToX);
    }
  }
  for (const column of keyColumns) {
    const rowIndex = rowIndexById.get(column.rowId);
    if (rowIndex != null && rowIndex >= firstRow && rowIndex < lastRow) {
      drawKeyColumn(context, column, rowIndex, transform.timeToX);
    }
  }

  if (range.enabled) {
    const startX = transform.timeToX(range.start);
    const endX = transform.timeToX(range.end);
    context.fillStyle = "rgba(10, 10, 13, 0.45)";
    context.fillRect(viewport.left, viewport.top, Math.max(0, startX - viewport.left), viewport.height);
    context.fillRect(endX, viewport.top, Math.max(0, viewport.left + viewport.width - endX), viewport.height);
    context.fillStyle = "rgba(90, 143, 224, 0.10)";
    context.fillRect(startX, viewport.top, Math.max(0, endX - startX), viewport.height);
    context.strokeStyle = "#5a8fe0";
    context.beginPath();
    context.moveTo(startX + 0.5, viewport.top);
    context.lineTo(startX + 0.5, viewport.top + viewport.height);
    context.moveTo(endX + 0.5, viewport.top);
    context.lineTo(endX + 0.5, viewport.top + viewport.height);
    context.stroke();
  }

}

export function Timeline({ dataSource = runtimeTimelineDataSource, variant = "compact" }: TimelineProps) {
  const revision = useSyncExternalStore(
    dataSource.subscribe,
    dataSource.getRevision,
    dataSource.getRevision,
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasPlayheadRef = useRef<HTMLDivElement>(null);
  const compactPlayheadRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const timeDisplayModeRef = useRef<TimelineDisplayMode>("frames");
  const pixelsPerSecondRef = useRef(MIN_PIXELS_PER_SECOND);
  const timeEndRef = useRef(1);
  const rulerPlayheadRef = useRef<HTMLDivElement>(null);
  const frameReadoutRef = useRef<HTMLButtonElement>(null);
  const timeReadoutRef = useRef<HTMLButtonElement>(null);
  const treeRowsRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const [zoomRange, setZoomRange] = useState<RangeViewportValue>({ start: 2, end: 52 });
  const pixelsPerSecond = pixelsPerSecondFromZoomRange(zoomRange);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 12 });
  const [canvasWindow, setCanvasWindow] = useState<CanvasWindow>({ left: 0, top: 0, width: 0, height: 0 });
  const [playheadTime, setPlayheadTime] = useState(PLAYHEAD_TIME);
  const [timeDisplayMode, setTimeDisplayMode] = useState<TimelineDisplayMode>("frames");
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const hasTauriRuntime = "__TAURI_INTERNALS__" in window;
  const [playbackConnection, setPlaybackConnection] = useState<PlaybackConnectionState>(() =>
    createPlaybackConnectionState(hasTauriRuntime),
  );
  const playbackConnectionRef = useRef<PlaybackConnectionState>(playbackConnection);
  const nativePlayback = playbackConnection.kind === "native-available" ? playbackConnection.snapshot : null;
  const browserPreview = playbackConnection.kind === "browser-preview";
  const controlsEnabled = playbackControlsEnabled(playbackConnection);
  const nativePlaybackRef = useRef<TimelinePlaybackSnapshot | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<TimelinePlaybackTarget | null>(null);
  const selectedTargetRef = useRef<TimelinePlaybackTarget | null>(null);
  const acceptedPlaybackRef = useRef<TimelinePlaybackSnapshot | null>(null);
  const acceptedPlaybackGenerationRef = useRef(0);
  const playbackFlightIdRef = useRef(0);
  const playbackFlightRef = useRef<TimelinePlaybackCommandFlight | null>(null);
  const lastCommandResultSequenceRef = useRef(0);
  const nativePlaybackEpochRef = useRef(0);
  const playbackDispatcherRef = useRef<ReturnType<typeof createTimelinePlaybackDispatcher> | null>(null);
  const dispatchPlayback = useCallback((command: TimelinePlaybackCommand, epoch: number, requestId?: number) => {
    const dispatcher = playbackDispatcherRef.current ?? createTimelinePlaybackDispatcher();
    playbackDispatcherRef.current = dispatcher;
    return dispatcher.dispatch(command, epoch, requestId);
  }, []);
  const setSelectedPlaybackTarget = useCallback((target: TimelinePlaybackTarget | null) => {
    selectedTargetRef.current = target;
    setSelectedTarget((current) => timelinePlaybackTargetEquals(current, target) ? current : target);
  }, []);
  const selectPlaybackRow = useCallback((rowId: TimelineRow["id"]) => {
    const target = dataSource.getPlaybackTarget?.(rowId) ?? null;
    if (target) setSelectedPlaybackTarget(target);
  }, [dataSource, setSelectedPlaybackTarget]);
  const handlePlaybackRowKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>, rowId: TimelineRow["id"]) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectPlaybackRow(rowId);
  }, [selectPlaybackRow]);
  const playheadTimeRef = useRef(PLAYHEAD_TIME);
  const [rangeEnabled, setRangeEnabled] = useState(true);
  const [rangeStart, setRangeStart] = useState(2);
  const [rangeEnd, setRangeEnd] = useState(9.5);

  useEffect(() => () => {
    playbackDispatcherRef.current?.dispose();
    playbackDispatcherRef.current = null;
  }, []);

  const rowCount = useMemo(
    () => Math.max(0, Math.floor(dataSource.getRowCount())),
    [dataSource, revision],
  );
  const timelineRange = useMemo(() => dataSource.getRange(), [dataSource, revision]);
  const timeEnd = Math.max(1, timelineRange.end);
  pixelsPerSecondRef.current = pixelsPerSecond;
  timeEndRef.current = timeEnd;
  const displayRange = useMemo(() => {
    const usesNativeFullRange = nativePlayback !== null;
    const usesFullRange = usesNativeFullRange || !rangeEnabled;
    const start = usesFullRange ? 0 : Math.min(timeEnd, Math.max(0, rangeStart));
    const end = usesFullRange
      ? timeEnd
      : Math.max(start, Math.min(timeEnd, rangeEnd));
    return {
      enabled: rangeEnabled || loop,
      start,
      end,
    };
  }, [loop, nativePlayback, rangeEnabled, rangeEnd, rangeStart, timeEnd]);
  const visibleRowQuery = useMemo(
    () => visibleTimelineRowQuery(rowCount, canvasWindow.top, canvasWindow.height),
    [rowCount, canvasWindow.top, canvasWindow.height],
  );
  const rows = useMemo(
    () => variant === "full" ? dataSource.getRows(visibleRowQuery) : [],
    [dataSource, revision, variant, visibleRowQuery],
  );
  const visibleTreeRows = rows;
  const rowIds = useMemo(() => visibleTreeRows.map((row) => row.id), [visibleTreeRows]);
  const items = useMemo(
    () => variant === "full" ? dataSource.getItems({ rowIds, range: visibleRange }) : [],
    [dataSource, revision, rowIds, variant, visibleRange],
  );
  const compactRows = useMemo(
    () => dataSource.getRows({ start: 0, count: 3 }),
    [dataSource, revision],
  );
  const compactRowIds = useMemo(() => compactRows.map((row) => row.id), [compactRows]);
  const compactItems = useMemo(
    () => dataSource.getItems({ rowIds: compactRowIds, range: { start: 0, end: timeEnd } }),
    [dataSource, revision, compactRowIds, timeEnd],
  );
  const compactItemsByRow = useMemo(() => {
    const grouped = new Map<TimelineRow["id"], TimelineItem[]>();
    for (const item of compactItems) {
      const current = grouped.get(item.rowId);
      if (current) current.push(item);
      else grouped.set(item.rowId, [item]);
    }
    return grouped;
  }, [compactItems]);
  const keys = useMemo(
    () => variant === "full" && !dataSource.getKeyColumns
      ? dataSource.getKeys({ rowIds, range: visibleRange })
      : [],
    [dataSource, revision, rowIds, variant, visibleRange],
  );
  const keyColumns = useMemo(
    () => variant === "full"
      ? dataSource.getKeyColumns?.({ rowIds, range: visibleRange }, pixelsPerSecond) ?? []
      : [],
    [dataSource, revision, rowIds, variant, visibleRange, pixelsPerSecond],
  );
  const bindingById = useMemo(
    () => new Map(dataSource.getBindings().map((binding) => [binding.id, binding])),
    [dataSource, revision],
  );
  const presentPlayhead = useCallback((time: number) => {
    const currentTimeEnd = timeEndRef.current;
    const currentPixelsPerSecond = pixelsPerSecondRef.current;
    const normalized = clampTimelineTime(time, currentTimeEnd);
    playheadTimeRef.current = normalized;
    const offset = `${normalized * currentPixelsPerSecond}px`;
    if (canvasPlayheadRef.current) canvasPlayheadRef.current.style.transform = `translateX(${offset})`;
    if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.transform = `translateX(${offset})`;
    if (compactPlayheadRef.current) {
      compactPlayheadRef.current.style.left = `${(normalized / Math.max(currentTimeEnd, 0.001)) * 100}%`;
    }
    if (frameReadoutRef.current) {
      frameReadoutRef.current.textContent = formatTimelineReadout(
        normalized,
        currentTimeEnd,
        timeDisplayModeRef.current,
      );
    }
    if (timeReadoutRef.current) {
      timeReadoutRef.current.textContent = formatCompactTimelineReadout(
        normalized,
        currentTimeEnd,
        timeDisplayModeRef.current,
      );
    }
    return normalized;
  }, []);

  useEffect(() => {
    presentPlayhead(playheadTimeRef.current);
  }, [pixelsPerSecond, presentPlayhead, timeEnd]);

  const updateCanvasWindow = useCallback((viewport: HTMLDivElement) => {
    const currentPixelsPerSecond = pixelsPerSecondRef.current;
    const currentTimeEnd = timeEndRef.current;
    const nextWindow = {
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    };
    setCanvasWindow((current) =>
      current.left === nextWindow.left &&
      current.top === nextWindow.top &&
      current.width === nextWindow.width &&
      current.height === nextWindow.height
        ? current
        : nextWindow,
    );
    const nextRange = {
      start: nextWindow.left / currentPixelsPerSecond,
      end: Math.min(currentTimeEnd + 0.001, (nextWindow.left + nextWindow.width) / currentPixelsPerSecond),
    };
    setVisibleRange((current) =>
      current.start === nextRange.start && current.end === nextRange.end ? current : nextRange,
    );
  }, []);

  useEffect(() => {
    if (variant !== "full") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    paintTimeline(canvas, rows, visibleRowQuery.start, items, keys, keyColumns, pixelsPerSecond, timeEnd, canvasWindow, {
      ...displayRange,
    });
  }, [canvasWindow, displayRange, items, keyColumns, keys, pixelsPerSecond, rows, timeEnd, variant, visibleRowQuery.start]);

  useEffect(() => {
    if (!hasTauriRuntime) return;
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
    const applySnapshot = (snapshot: TimelinePlaybackSnapshot, measure: boolean) => {
      if (disposed) return;
      if (snapshot.epoch < nativePlaybackEpochRef.current) return;
      nativePlaybackEpochRef.current = snapshot.epoch;
      const measureEvent = measure && sampleTarget > 0 && deliveryAges.length < sampleTarget;
      // Count sequence continuity for every event received by the listener, including a
      // stale revision that is intentionally ignored for playback state application.
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
      const previousAcceptedTarget = resolveTimelinePlaybackTarget(null, acceptedPlaybackRef.current);
      const nextSnapshotTarget = resolveTimelinePlaybackTarget(null, snapshot);
      acceptedPlaybackGenerationRef.current += 1;
      acceptedPlaybackRef.current = snapshot.available ? snapshot : null;
      playbackFlightRef.current = null;
      if (
        selectedTargetRef.current === null ||
        !timelinePlaybackTargetEquals(previousAcceptedTarget, nextSnapshotTarget)
      ) {
        setSelectedPlaybackTarget(nextSnapshotTarget);
      }
      const nextConnection = acceptance.state;
      if (nextConnection !== currentConnection) {
        playbackConnectionRef.current = nextConnection;
        setPlaybackConnection(nextConnection);
      }
      if (snapshot.available) {
        nativePlaybackRef.current = snapshot;
        const projectedTime = projectTimelinePlaybackTime(snapshot);
        const presentedTime = presentPlayhead(projectedTime);
        if (!snapshot.playing) setPlayheadTime(presentedTime);
        setIsPlaying(snapshot.playing);
        setLoop(snapshot.looping);
        setRangeEnabled(false);
      } else {
        nativePlaybackRef.current = null;
        setIsPlaying(false);
        setLoop(false);
        setPlayheadTime(0);
        presentPlayhead(0);
      }
      if (rejectedFlight && currentFlight && snapshot.available && currentFlight.rollbackSnapshot.available) {
        const restoredTime = projectTimelinePlaybackTime(currentFlight.rollbackSnapshot);
        nativePlaybackRef.current = {
          ...currentFlight.rollbackSnapshot,
          commandResults: snapshot.commandResults,
        };
        setIsPlaying(currentFlight.rollbackSnapshot.playing);
        setLoop(currentFlight.rollbackSnapshot.looping);
        setPlayheadTime(restoredTime);
        presentPlayhead(restoredTime);
        reportTimelinePlaybackCommandFailure(rejectedFlight.error ?? "unknown error");
      }
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
      (error) => {
        if (disposed) return;
        window.dispatchEvent(new CustomEvent("tauri3d:diagnostic", {
          detail: {
            level: "error",
            source: "timeline",
            message: `Native Timeline playback unavailable: ${safeDiagnosticText(error)}`,
          },
        }));
      },
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
        if (disposed) return;
        window.dispatchEvent(new CustomEvent("tauri3d:diagnostic", {
          detail: {
            level: "error",
            source: "timeline",
            message: `Native Timeline playback unavailable: ${safeDiagnosticText(error)}`,
          },
        }));
      });
    return () => {
      disposed = true;
      listener.dispose();
    };
  }, [hasTauriRuntime, presentPlayhead, setSelectedPlaybackTarget]);

  useEffect(() => {
    if (!isPlaying || !nativePlayback) return;
    let animationFrame = 0;
    const updateProjectedTime = () => {
      const snapshot = nativePlaybackRef.current;
      if (snapshot?.playing) presentPlayhead(projectTimelinePlaybackTime(snapshot));
      animationFrame = window.requestAnimationFrame(updateProjectedTime);
    };
    animationFrame = window.requestAnimationFrame(updateProjectedTime);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isPlaying, presentPlayhead]);

  useEffect(() => {
    if (!browserPreview || !isPlaying) return;
    let current = playheadTimeRef.current;
    const timer = window.setInterval(() => {
      const next = current + 1 / TIMELINE_FPS;
      const start = rangeEnabled ? rangeStart : 0;
      const end = rangeEnabled ? rangeEnd : timeEnd;
      if (next >= end) {
        current = loop ? start : end;
        presentPlayhead(current);
        if (!loop) {
          setPlayheadTime(current);
          setIsPlaying(false);
        }
        return;
      }
      current = next;
      presentPlayhead(current);
    }, 1000 / TIMELINE_FPS);
    return () => window.clearInterval(timer);
  }, [browserPreview, isPlaying, loop, rangeEnabled, rangeStart, rangeEnd, timeEnd, presentPlayhead]);

  useEffect(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    const update = () => updateCanvasWindow(viewport);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [updateCanvasWindow]);

  useEffect(() => {
    const viewport = canvasViewportRef.current;
    if (viewport) updateCanvasWindow(viewport);
  }, [pixelsPerSecond, timeEnd, updateCanvasWindow]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (
      timelineSelfTestHasRun ||
      !import.meta.env.VITE_TIMELINE_SELF_TEST ||
      canvasWindow.width === 0 ||
      canvasWindow.height === 0
    ) return;
    timelineSelfTestHasRun = true;
    let completed = false;
    const timers = createSelfTestTimerBag();
    timers.schedule(() => setZoomRange({ start: 2, end: 20.75 }), 2000);
    timers.schedule(() => {
      const viewport = canvasViewportRef.current;
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
  }, [canvasWindow.width, canvasWindow.height]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (
      timelinePlaybackSelfTestHasRun ||
      !import.meta.env.VITE_TIMELINE_PLAYBACK_SELF_TEST ||
      !nativePlayback?.available ||
      !nativePlayback.instanceId ||
      nativePlayback.clipIndex === null
    ) return;
    timelinePlaybackSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    const target = resolveTimelinePlaybackTarget(selectedTargetRef.current, nativePlayback);
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
          !pausedA.playing &&
          !pausedB.playing &&
          Math.abs(pausedB.time - pausedA.time) < 0.02 &&
          !sought.playing &&
          Math.abs(sought.time - seekTime) < 0.05 &&
          resumed.playing &&
          resumed.time > sought.time + 0.1 &&
          !final.playing &&
          final.time >= resumed.time;
        window.dispatchEvent(new CustomEvent("tauri3d:diagnostic", {
          detail: {
            level: passed ? "info" : "error",
            source: "timeline",
            message: `${passed ? "PASS" : "FAIL"} Native Timeline pause/seek/play self-test: ${final.time.toFixed(2)}s`,
          },
        }));
        completed = true;
      } catch (error) {
        if (!timers.isCancelled()) {
          window.dispatchEvent(new CustomEvent("tauri3d:diagnostic", {
            detail: {
              level: "error",
              source: "timeline",
              message: `FAIL Native Timeline playback self-test: ${safeDiagnosticText(error)}`,
            },
          }));
        }
      }
    })();
    return () => {
      unregister();
      timers.cancel();
      if (!completed) timelinePlaybackSelfTestHasRun = false;
    };
  }, [
    dispatchPlayback,
    nativePlayback?.available,
    nativePlayback?.instanceId,
    nativePlayback?.clipIndex,
    nativePlayback?.epoch,
  ]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (treeRowsRef.current) {
      treeRowsRef.current.style.transform = `translateY(${-target.scrollTop}px)`;
    }
    if (rulerRef.current) {
      rulerRef.current.style.transform = `translateX(${-target.scrollLeft}px)`;
    }
    updateCanvasWindow(target);
  };

  const tickStep = pixelsPerSecond < 18 ? 5 : 1;
  const ticks = useMemo(
    () => variant === "full"
      ? visibleTimelineTicks(
        timeEnd,
        canvasWindow.left,
        canvasWindow.width,
        pixelsPerSecond,
        tickStep,
      )
      : [],
    [canvasWindow.left, canvasWindow.width, pixelsPerSecond, tickStep, timeEnd, variant],
  );
  const canvasWidth = timeEnd * pixelsPerSecond;
  const sendNative = useCallback((command: "play" | "pause" | "seek" | "setLooping", value?: number | boolean) => {
    const currentPlayback = nativePlaybackRef.current;
    if (!currentPlayback?.instanceId || currentPlayback.clipIndex === null) return false;
    const rollbackSnapshot = acceptedPlaybackRef.current ?? currentPlayback;
    const target = resolveTimelinePlaybackTarget(selectedTargetRef.current, currentPlayback);
    if (!target) return false;
    const payload: TimelinePlaybackCommand = command === "seek"
      ? { type: command, ...target, time: value as number }
      : command === "setLooping"
        ? { type: command, ...target, looping: value as boolean }
        : { type: command, ...target };
    const flight = createTimelinePlaybackCommandFlight(
      ++playbackFlightIdRef.current,
      acceptedPlaybackGenerationRef.current,
      payload,
      currentPlayback.epoch,
      rollbackSnapshot,
    );
    playbackFlightRef.current = flight;
    void dispatchPlayback(payload, currentPlayback.epoch, flight.requestId).catch((error) => {
      if (!shouldRollbackTimelinePlaybackCommand(
        flight,
        playbackFlightRef.current,
        acceptedPlaybackGenerationRef.current,
        acceptedPlaybackRef.current,
      )) {
        return;
      }
      playbackFlightRef.current = null;
      const restoredTime = projectTimelinePlaybackTime(flight.rollbackSnapshot);
      nativePlaybackRef.current = flight.rollbackSnapshot;
      setIsPlaying(flight.rollbackSnapshot.playing);
      setLoop(flight.rollbackSnapshot.looping);
      setPlayheadTime(restoredTime);
      presentPlayhead(restoredTime);
      reportTimelinePlaybackCommandFailure(error);
    });
    return true;
  }, [dispatchPlayback, presentPlayhead]);
  const togglePlayback = useCallback(() => {
    if (!controlsEnabled) return;
    const next = !isPlaying;
    const snapshot = nativePlaybackRef.current;
    if (snapshot) {
      nativePlaybackRef.current = {
        ...snapshot,
        playing: next,
        time: playheadTimeRef.current,
        sampledAtUnixMs: Date.now(),
      };
    }
    if (!next) setPlayheadTime(playheadTimeRef.current);
    setIsPlaying(next);
    sendNative(next ? "play" : "pause");
  }, [controlsEnabled, isPlaying, sendNative]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (isTimelineTextEditingTarget(event.target)) return;
      if (!controlsEnabled) return;
      event.preventDefault();
      event.stopPropagation();
      togglePlayback();
    };
    // Capture before focused buttons/selects can run their native Space
    // activation. Text editing controls remain exempt so spaces can still be
    // entered into search/name fields.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [controlsEnabled, togglePlayback]);

  const seekTo = (time: number, policy: TimelineSeekPolicy = "unsnapped") => {
    if (!controlsEnabled) return;
    const normalized = resolveTimelineSeekTime(time, timeEnd, policy, TIMELINE_FPS);
    const snapshot = nativePlaybackRef.current;
    if (snapshot) {
      nativePlaybackRef.current = { ...snapshot, time: normalized, sampledAtUnixMs: Date.now() };
    }
    presentPlayhead(normalized);
    setPlayheadTime(normalized);
    sendNative("seek", normalized);
  };
  const toggleTimeDisplayMode = () => {
    const next = timeDisplayModeRef.current === "frames" ? "seconds" : "frames";
    timeDisplayModeRef.current = next;
    setTimeDisplayMode(next);
    presentPlayhead(playheadTimeRef.current);
  };
  const seekFromTimelinePosition = (clientX: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const scrollLeft = canvasViewportRef.current?.scrollLeft ?? 0;
    const policy: TimelineSeekPolicy = timeDisplayModeRef.current === "frames" ? "frame-snap" : "unsnapped";
    seekTo((clientX - rect.left + scrollLeft) / pixelsPerSecond, policy);
  };
  const seekFromCompactPosition = (clientX: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const policy: TimelineSeekPolicy = timeDisplayModeRef.current === "frames" ? "frame-snap" : "unsnapped";
    seekTo(((clientX - rect.left) / rect.width) * timeEnd, policy);
  };
  const beginTimelineScrub = (event: PointerEvent<HTMLElement>) => {
    if (!controlsEnabled || event.button !== 0) return;
    scrubbingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromTimelinePosition(event.clientX, event.currentTarget);
    event.preventDefault();
  };
  const moveTimelineScrub = (event: PointerEvent<HTMLElement>) => {
    if (!scrubbingRef.current) return;
    seekFromTimelinePosition(event.clientX, event.currentTarget);
  };
  const beginCompactScrub = (event: PointerEvent<HTMLElement>) => {
    if (!controlsEnabled || event.button !== 0) return;
    scrubbingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromCompactPosition(event.clientX, event.currentTarget);
    event.preventDefault();
  };
  const moveCompactScrub = (event: PointerEvent<HTMLElement>) => {
    if (!scrubbingRef.current) return;
    seekFromCompactPosition(event.clientX, event.currentTarget);
  };
  const endScrub = (event: PointerEvent<HTMLElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const nudgePlayhead = (delta: number) => {
    const min = displayRange.enabled ? displayRange.start : 0;
    const max = displayRange.enabled ? displayRange.end : timeEnd;
    seekTo(Math.min(max, Math.max(min, playheadTimeRef.current + delta)));
  };
  const jumpTo = (time: number) => seekTo(time);
  const jumpToPreviousKey = () => jumpTo(Math.max(0, Math.ceil(playheadTimeRef.current) - 1));
  const jumpToNextKey = () => jumpTo(Math.min(timeEnd, Math.floor(playheadTimeRef.current) + 1));
  const playbackStatus = formatTimelinePlaybackStatus(playbackConnection, isPlaying);

  if (variant === "compact") {
    const compactTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
      ratio,
      time: timeEnd * ratio,
    }));
    return (
      <section className="timeline-panel timeline-panel--compact" aria-label="Timeline playback">
        <span className="timeline-panel__live-status" role="status" aria-live="polite" aria-atomic="true">
          {playbackStatus}
        </span>
        <header className="timeline-panel__header timeline-panel__compact-header">
          <div className="timeline-panel__tabs" role="group" aria-label="Bottom panel">
            <button className="timeline-panel__tab timeline-panel__tab--active" type="button" aria-pressed="true">
              Timeline
            </button>
            <button
              className="timeline-panel__tab"
              type="button"
              aria-pressed="false"
              onClick={(event) => {
                focusLazyPanelHost(event.currentTarget);
                window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }));
              }}
            >
              Console
            </button>
          </div>
          <div className="timeline-panel__toolbar timeline-panel__compact-toolbar">
            <div className="timeline-panel__compact-controls">
              <button className="timeline-transport" type="button" aria-label="Go to start" disabled={!controlsEnabled} onClick={() => jumpTo(0)}>◀|</button>
              <button className="timeline-transport" type="button" aria-label="Previous frame" disabled={!controlsEnabled} onClick={() => nudgePlayhead(-1 / TIMELINE_FPS)}>◀</button>
              <button
                className="timeline-transport timeline-transport--play"
                type="button"
                aria-label={isPlaying ? "Pause" : "Play"}
                aria-pressed={isPlaying}
                disabled={!controlsEnabled}
                onClick={togglePlayback}
              >
                {isPlaying ? "Ⅱ" : "▶"}
              </button>
              <button className="timeline-transport" type="button" aria-label="Next frame" disabled={!controlsEnabled} onClick={() => nudgePlayhead(1 / TIMELINE_FPS)}>▶</button>
              <button className="timeline-transport" type="button" aria-label="Go to end" disabled={!controlsEnabled} onClick={() => jumpTo(timeEnd)}>▶|</button>
              <button
                className="timeline-panel__compact-readout timeline-panel__time-toggle"
                type="button"
                ref={timeReadoutRef}
                aria-label={`Switch to ${timeDisplayMode === "frames" ? "seconds" : "frames"} display`}
                title="Click to switch between frames and seconds"
                onClick={toggleTimeDisplayMode}
              >
                {formatCompactTimelineReadout(playheadTime, timeEnd, timeDisplayMode)}
              </button>
              <span className="timeline-panel__fps">{TIMELINE_FPS} fps</span>
              <button
                className={`timeline-tool timeline-tool--loop${loop ? " timeline-tool--active" : ""}`}
                type="button"
                aria-label="Loop"
                title={loop ? "Loop: On" : "Loop: Off"}
                aria-pressed={loop}
                disabled={!controlsEnabled}
                onClick={() => {
                  if (!controlsEnabled) return;
                  const next = !loop;
                  const snapshot = nativePlaybackRef.current;
                  if (snapshot) nativePlaybackRef.current = { ...snapshot, looping: next };
                  setLoop(next);
                  sendNative("setLooping", next);
                }}
              >
                <LoopIcon />
              </button>
            </div>
          </div>
        </header>
        <div className="timeline-panel__compact-body">
          <div className="timeline-panel__compact-track-heading">TRACKS</div>
          <div className="timeline-panel__compact-track-list">
            {compactRows.length > 0 ? compactRows.map((row, rowIndex) => {
              const binding = row.bindingId ? bindingById.get(row.bindingId) : undefined;
              const rowTarget = dataSource.getPlaybackTarget?.(row.id) ?? null;
              const isSelected = timelinePlaybackTargetEquals(rowTarget, selectedTarget);
              return (
                <div
                  className={`timeline-row timeline-panel__compact-row timeline-row--${row.kind}${rowIndex % 2 === 0 ? " timeline-row--alternate" : ""}${isSelected ? " timeline-row--selected" : ""}`}
                  key={row.id}
                  style={{ height: 20, paddingLeft: 6 + row.depth * 8 }}
                  role={rowTarget ? "button" : undefined}
                  tabIndex={rowTarget ? 0 : -1}
                  aria-pressed={rowTarget ? isSelected : undefined}
                  onClick={() => selectPlaybackRow(row.id)}
                  onKeyDown={(event) => handlePlaybackRowKeyDown(event, row.id)}
                >
                  <span className="timeline-row__disclosure">{row.kind === "group" ? "▾" : ""}</span>
                  <span className="timeline-row__color" style={{ backgroundColor: row.color }} />
                  <span className="timeline-row__label">{row.label}</span>
                  {binding && <span className="timeline-row__binding">{binding.label}</span>}
                </div>
              );
            }) : <div className="timeline-panel__compact-empty-row">No tracks</div>}
          </div>
          <div
            className="timeline-panel__compact-track-panel"
            onPointerDown={beginCompactScrub}
            onPointerMove={moveCompactScrub}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            title="Click or drag to scrub the playhead"
          >
            <div className="timeline-panel__compact-ruler">
              {compactTicks.map(({ ratio, time }) => (
                <span className="timeline-panel__compact-tick" key={ratio} style={{ left: `${ratio * 100}%` }}>
                  {formatTimelineTick(time, timeDisplayMode)}
                </span>
              ))}
            </div>
            <div className="timeline-panel__compact-track-area">
              {compactRows.map((row, rowIndex) => (
                <div
                  className={`timeline-panel__compact-track-lane timeline-panel__compact-track-lane--${row.kind}${rowIndex % 2 === 0 ? " is-alternate" : ""}`}
                  key={row.id}
                >
                  {compactItemsByRow.get(row.id)?.map((item) => {
                    const start = item.kind === "clip" ? item.range.start : item.time;
                    const width = item.kind === "clip"
                      ? `${Math.max(1, ((item.range.end - item.range.start) / timeEnd) * 100)}%`
                      : undefined;
                    return (
                      <span
                        className={`timeline-panel__compact-item timeline-panel__compact-item--${item.kind}`}
                        key={item.id}
                        style={{ left: `${(start / timeEnd) * 100}%`, width, backgroundColor: item.color }}
                        title={item.label}
                      >
                        {item.kind === "clip" ? item.label : ""}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
            {displayRange.enabled && (
              <div className="timeline-panel__compact-range" aria-hidden="true">
                <span
                  className="timeline-panel__compact-range-shade"
                  style={{ width: `${(displayRange.start / timeEnd) * 100}%` }}
                />
                <span
                  className="timeline-panel__compact-range-fill"
                  style={{
                    left: `${(displayRange.start / timeEnd) * 100}%`,
                    width: `${((displayRange.end - displayRange.start) / timeEnd) * 100}%`,
                  }}
                />
                <span
                  className="timeline-panel__compact-range-shade"
                  style={{
                    left: `${(displayRange.end / timeEnd) * 100}%`,
                    right: 0,
                  }}
                />
                <span
                  className="timeline-panel__compact-range-edge"
                  style={{ left: `${(displayRange.start / timeEnd) * 100}%` }}
                />
                <span
                  className="timeline-panel__compact-range-edge"
                  style={{ left: `${(displayRange.end / timeEnd) * 100}%` }}
                />
              </div>
            )}
            <div className="timeline-panel__compact-playhead" ref={compactPlayheadRef} aria-hidden="true" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="timeline-panel" aria-label="Timeline editor preview">
      <span className="timeline-panel__live-status" role="status" aria-live="polite" aria-atomic="true">
        {playbackStatus}
      </span>
      <header className="timeline-panel__header">
        <div className="timeline-panel__tabs" role="group" aria-label="Bottom panel">
          <button className="timeline-panel__tab timeline-panel__tab--active" type="button" aria-pressed="true">
            Timeline
          </button>
          <button
            className="timeline-panel__tab"
            type="button"
            aria-pressed="false"
            onClick={(event) => {
              focusLazyPanelHost(event.currentTarget);
              window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }));
            }}
          >
            Console
          </button>
        </div>
        <div className="timeline-panel__toolbar">
          <div className="timeline-panel__tools">
          <button className="timeline-transport" type="button" aria-label="Go to start" disabled={!controlsEnabled} onClick={() => jumpTo(0)}>◀|</button>
          <button className="timeline-transport" type="button" aria-label="Previous key" disabled={!controlsEnabled} onClick={jumpToPreviousKey}>◆◀</button>
          <button className="timeline-transport" type="button" aria-label="Previous frame" disabled={!controlsEnabled} onClick={() => nudgePlayhead(-1 / TIMELINE_FPS)}>◀</button>
          <button
            className="timeline-transport timeline-transport--play"
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            aria-pressed={isPlaying}
            disabled={!controlsEnabled}
            onClick={togglePlayback}
          >
            {isPlaying ? "Ⅱ" : "▶"}
          </button>
          <button className="timeline-transport" type="button" aria-label="Next frame" disabled={!controlsEnabled} onClick={() => nudgePlayhead(1 / TIMELINE_FPS)}>▶</button>
          <button className="timeline-transport" type="button" aria-label="Next key" disabled={!controlsEnabled} onClick={jumpToNextKey}>▶◆</button>
          <button className="timeline-transport" type="button" aria-label="Go to end" disabled={!controlsEnabled} onClick={() => jumpTo(timeEnd)}>▶|</button>
          <button
            className={`timeline-transport timeline-tool--loop${loop ? " timeline-tool--active" : ""}`}
            type="button"
            aria-label="Loop"
            title={loop ? "Loop: On" : "Loop: Off"}
            aria-pressed={loop}
            disabled={!controlsEnabled}
            onClick={() => {
              if (!controlsEnabled) return;
              const next = !loop;
              const snapshot = nativePlaybackRef.current;
              if (snapshot) nativePlaybackRef.current = { ...snapshot, looping: next };
              setLoop(next);
              sendNative("setLooping", next);
            }}
          ><LoopIcon /></button>
          <button
            className="timeline-panel__frame timeline-panel__time-toggle"
            type="button"
            ref={frameReadoutRef}
            aria-label={`Switch to ${timeDisplayMode === "frames" ? "seconds" : "frames"} display`}
            title="Click to switch between frames and seconds"
            onClick={toggleTimeDisplayMode}
          >
            {formatTimelineReadout(playheadTime, timeEnd, timeDisplayMode)}
          </button>
          <span className="timeline-panel__divider" />
          <button className="timeline-tool timeline-tool--active" type="button">Select</button>
          <button className="timeline-tool" type="button" disabled title="Snapping is preview-only">Snap</button>
          <button
            className={`timeline-tool timeline-tool--range${rangeEnabled ? " timeline-tool--active" : ""}`}
            type="button"
            aria-pressed={rangeEnabled}
            disabled={!controlsEnabled || nativePlayback !== null}
            title={nativePlayback ? "Range playback is not connected to the Native player yet" : undefined}
            onClick={() => setRangeEnabled((enabled) => !enabled)}
          >
            Range
          </button>
          </div>
          <div className="timeline-panel__readout">
            <span className="timeline-panel__status-dot" />
            <span className="timeline-panel__fps">{TIMELINE_FPS} fps</span>
            <label className="timeline-panel__zoom">
              Zoom
              <RangeViewport
                aria-label="Timeline zoom"
                start={zoomRange.start}
                end={zoomRange.end}
                onChange={setZoomRange}
              />
            </label>
            <label className="timeline-panel__range-field">
              <span>Range</span>
              <CompactNumberInput
                aria-label="Range start"
                min="0"
                max={rangeEnd}
                step="0.1"
                value={rangeStart}
                disabled={!rangeEnabled || !controlsEnabled}
                onChange={(event) => setRangeStart(Math.max(0, Math.min(rangeEnd - 0.1, event.currentTarget.valueAsNumber || 0)))}
              />
              <span>–</span>
              <CompactNumberInput
                aria-label="Range end"
                min={rangeStart + 0.1}
                max={timeEnd}
                step="0.1"
                value={rangeEnd}
                disabled={!rangeEnabled || !controlsEnabled}
                onChange={(event) => setRangeEnd(Math.min(timeEnd, Math.max(rangeStart + 0.1, event.currentTarget.valueAsNumber || timeEnd)))}
              />
            </label>
          </div>
        </div>
      </header>

      <div className="timeline-panel__body">
        <div className="timeline-panel__tree-heading">
          <span>TRACKS</span>
          <span className="timeline-panel__tree-actions">＋ ⋯</span>
        </div>
        <div
          className="timeline-panel__ruler-viewport"
          onPointerDown={beginTimelineScrub}
          onPointerMove={moveTimelineScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          title="Click or drag to scrub the playhead"
        >
          <div className="timeline-panel__ruler" ref={rulerRef} style={{ width: canvasWidth }}>
            {ticks.map((second) => (
              <div
                className="timeline-panel__tick"
                key={second}
                style={{ left: second * pixelsPerSecond }}
              >
                <span>{String(second).padStart(2, "0")}:00</span>
              </div>
            ))}
            {displayRange.enabled && (
              <div className="timeline-panel__ruler-range" aria-hidden="true">
                <span
                  className="timeline-panel__ruler-range-fill"
                  style={{
                    left: displayRange.start * pixelsPerSecond,
                    width: (displayRange.end - displayRange.start) * pixelsPerSecond,
                  }}
                />
                <span
                  className="timeline-panel__ruler-range-edge"
                  style={{ left: displayRange.start * pixelsPerSecond }}
                />
                <span
                  className="timeline-panel__ruler-range-edge"
                  style={{ left: displayRange.end * pixelsPerSecond }}
                />
              </div>
            )}
            <div className="timeline-panel__ruler-playhead" ref={rulerPlayheadRef} />
          </div>
        </div>

        <div className="timeline-panel__tree-viewport">
          <div className="timeline-panel__tree-content" ref={treeRowsRef} style={{ height: rowCount * ROW_HEIGHT }}>
            <div className="timeline-panel__tree-window" style={{ top: visibleRowQuery.start * ROW_HEIGHT }}>
              {visibleTreeRows.map((row, localIndex) => {
                const rowIndex = visibleRowQuery.start + localIndex;
                const binding = row.bindingId ? bindingById.get(row.bindingId) : undefined;
                const rowTarget = dataSource.getPlaybackTarget?.(row.id) ?? null;
                const isSelected = timelinePlaybackTargetEquals(rowTarget, selectedTarget);
                return (
                  <div
                    className={`timeline-row timeline-row--${row.kind}${rowIndex % 2 === 0 ? " timeline-row--alternate" : ""}${isSelected ? " timeline-row--selected" : ""}`}
                    key={row.id}
                    style={{ height: ROW_HEIGHT, paddingLeft: 10 + row.depth * 15 }}
                    role={rowTarget ? "button" : undefined}
                    tabIndex={rowTarget ? 0 : -1}
                    aria-pressed={rowTarget ? isSelected : undefined}
                    onClick={() => selectPlaybackRow(row.id)}
                    onKeyDown={(event) => handlePlaybackRowKeyDown(event, row.id)}
                  >
                    <span className="timeline-row__disclosure">{row.kind === "group" ? "▾" : ""}</span>
                    <span className="timeline-row__color" style={{ backgroundColor: row.color }} />
                    <span className="timeline-row__label">{row.label}</span>
                    {binding && <span className="timeline-row__binding">{binding.label}</span>}
                    {row.kind !== "group" && (
                      <>
                        <span className={`timeline-row__state ${row.muted ? "is-on" : ""}`}>M</span>
                        <span className={`timeline-row__state ${row.locked ? "is-on" : ""}`}>L</span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div
          className="timeline-panel__canvas-viewport"
          ref={canvasViewportRef}
          onScroll={handleScroll}
          onPointerDown={beginTimelineScrub}
          onPointerMove={moveTimelineScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          title="Click or drag to scrub the playhead"
        >
          <div
            className="timeline-panel__canvas-content"
            style={{ width: canvasWidth, height: rowCount * ROW_HEIGHT }}
          >
            <canvas ref={canvasRef} aria-label="Timeline tracks" />
            <div className="timeline-panel__canvas-playhead" ref={canvasPlayheadRef} aria-hidden="true" />
          </div>
        </div>
      </div>
    </section>
  );
}
