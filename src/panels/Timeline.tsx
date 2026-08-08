import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { runtimeTimelineDataSource } from "../timeline/adapters/gltfProjectionDataSource";
import {
  createViewTransform,
  type TimelineDataSource,
  type TimelineItem,
  type TimelineKey,
  type TimelineKeyColumn,
  type TimelineRow,
} from "../timeline/core/contracts";
import "./Timeline.css";

const ROW_HEIGHT = 26;
const DEFAULT_PIXELS_PER_SECOND = 60;
const PLAYHEAD_TIME = 4.55;
let timelineSelfTestHasRun = false;

interface TimelineProps {
  dataSource?: TimelineDataSource;
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
  items: readonly TimelineItem[],
  keys: readonly TimelineKey[],
  keyColumns: readonly TimelineKeyColumn[],
  pixelsPerSecond: number,
  timeEnd: number,
  playheadTime: number,
  range: { enabled: boolean; start: number; end: number },
) {
  const canvasWidth = Math.max(1, timeEnd * pixelsPerSecond);
  const height = rows.length * ROW_HEIGHT;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvasWidth * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${canvasWidth}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, canvasWidth, height);

  rows.forEach((row, index) => {
    const y = index * ROW_HEIGHT;
    context.fillStyle =
      row.kind === "group"
        ? "#22242d"
        : index % 2 === 0
          ? "#1c1e25"
          : "#191b21";
    context.fillRect(0, y, canvasWidth, ROW_HEIGHT);
    context.strokeStyle = "rgba(255, 255, 255, 0.055)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, y + ROW_HEIGHT - 0.5);
    context.lineTo(canvasWidth, y + ROW_HEIGHT - 0.5);
    context.stroke();
  });

  const gridStep = pixelsPerSecond >= 40 ? 0.5 : pixelsPerSecond >= 15 ? 1 : 5;
  for (let time = 0; time <= timeEnd; time += gridStep) {
    const x = time * pixelsPerSecond + 0.5;
    const major = Number.isInteger(time);
    context.strokeStyle = major
      ? "rgba(255, 255, 255, 0.105)"
      : "rgba(255, 255, 255, 0.045)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  const transform = createViewTransform(0, pixelsPerSecond);
  const rowIndexById = new Map(rows.map((row, index) => [row.id, index]));
  for (const item of items) {
    const rowIndex = rowIndexById.get(item.rowId);
    if (rowIndex != null) drawItem(context, item, rowIndex, transform.timeToX);
  }
  for (const key of keys) {
    const rowIndex = rowIndexById.get(key.rowId);
    if (rowIndex != null) drawKey(context, key, rowIndex, transform.timeToX);
  }
  for (const column of keyColumns) {
    const rowIndex = rowIndexById.get(column.rowId);
    if (rowIndex != null) drawKeyColumn(context, column, rowIndex, transform.timeToX);
  }

  if (range.enabled) {
    const startX = transform.timeToX(range.start);
    const endX = transform.timeToX(range.end);
    context.fillStyle = "rgba(10, 10, 13, 0.45)";
    context.fillRect(0, 0, Math.max(0, startX), height);
    context.fillRect(endX, 0, Math.max(0, canvasWidth - endX), height);
    context.fillStyle = "rgba(90, 143, 224, 0.10)";
    context.fillRect(startX, 0, Math.max(0, endX - startX), height);
    context.strokeStyle = "#5a8fe0";
    context.beginPath();
    context.moveTo(startX + 0.5, 0);
    context.lineTo(startX + 0.5, height);
    context.moveTo(endX + 0.5, 0);
    context.lineTo(endX + 0.5, height);
    context.stroke();
  }

  const playheadX = transform.timeToX(playheadTime) + 0.5;
  context.strokeStyle = "#ff5d73";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(playheadX, 0);
  context.lineTo(playheadX, height);
  context.stroke();
}

export function Timeline({ dataSource = runtimeTimelineDataSource }: TimelineProps) {
  const revision = useSyncExternalStore(
    dataSource.subscribe,
    dataSource.getRevision,
    dataSource.getRevision,
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const treeRowsRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 12 });
  const [playheadTime, setPlayheadTime] = useState(PLAYHEAD_TIME);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rangeEnabled, setRangeEnabled] = useState(true);
  const [rangeStart, setRangeStart] = useState(2);
  const [rangeEnd, setRangeEnd] = useState(9.5);

  const rows = useMemo(() => dataSource.getRows({ start: 0, count: 10_000 }), [dataSource, revision]);
  const timelineRange = useMemo(() => dataSource.getRange(), [dataSource, revision]);
  const timeEnd = Math.max(1, timelineRange.end);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const items = useMemo(
    () => dataSource.getItems({ rowIds, range: visibleRange }),
    [dataSource, revision, rowIds, visibleRange],
  );
  const keys = useMemo(
    () => (dataSource.getKeyColumns ? [] : dataSource.getKeys({ rowIds, range: visibleRange })),
    [dataSource, revision, rowIds, visibleRange],
  );
  const keyColumns = useMemo(
    () => dataSource.getKeyColumns?.({ rowIds, range: visibleRange }, pixelsPerSecond) ?? [],
    [dataSource, revision, rowIds, visibleRange, pixelsPerSecond],
  );
  const bindingById = useMemo(
    () => new Map(dataSource.getBindings().map((binding) => [binding.id, binding])),
    [dataSource, revision],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () =>
      paintTimeline(canvas, rows, items, keys, keyColumns, pixelsPerSecond, timeEnd, playheadTime, {
        enabled: rangeEnabled,
        start: rangeStart,
        end: rangeEnd,
      });
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [items, keyColumns, keys, pixelsPerSecond, rows, timeEnd, playheadTime, rangeEnabled, rangeStart, rangeEnd]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      setPlayheadTime((current) => {
        const next = current + 1 / 24;
        const start = rangeEnabled ? rangeStart : 0;
        const end = rangeEnabled ? rangeEnd : timeEnd;
        if (next >= end) {
          if (loop) return start;
          setIsPlaying(false);
          return end;
        }
        return next;
      });
    }, 1000 / 24);
    return () => window.clearInterval(timer);
  }, [isPlaying, loop, rangeEnabled, rangeStart, rangeEnd, timeEnd]);

  useEffect(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    const update = () => {
      setVisibleRange({
        start: viewport.scrollLeft / pixelsPerSecond,
        end: Math.min(timeEnd + 0.001, (viewport.scrollLeft + viewport.clientWidth) / pixelsPerSecond),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [pixelsPerSecond, timeEnd]);

  useEffect(() => {
    if (timelineSelfTestHasRun || !import.meta.env.VITE_TIMELINE_SELF_TEST) return;
    timelineSelfTestHasRun = true;
    const zoomTimer = window.setTimeout(() => setPixelsPerSecond(160), 2000);
    const scrollTimer = window.setTimeout(() => {
      const viewport = canvasViewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = 1800;
      viewport.scrollTop = 680;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, 4000);
    return () => {
      window.clearTimeout(zoomTimer);
      window.clearTimeout(scrollTimer);
    };
  }, []);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (treeRowsRef.current) {
      treeRowsRef.current.style.transform = `translateY(${-target.scrollTop}px)`;
    }
    if (rulerRef.current) {
      rulerRef.current.style.transform = `translateX(${-target.scrollLeft}px)`;
    }
    setVisibleRange({
      start: target.scrollLeft / pixelsPerSecond,
      end: Math.min(timeEnd + 0.001, (target.scrollLeft + target.clientWidth) / pixelsPerSecond),
    });
  };

  const tickStep = pixelsPerSecond < 18 ? 5 : 1;
  const ticks = Array.from({ length: Math.floor(timeEnd / tickStep) + 1 }, (_, index) => index * tickStep);
  const canvasWidth = timeEnd * pixelsPerSecond;
  const nudgePlayhead = (delta: number) => {
    const min = rangeEnabled ? rangeStart : 0;
    const max = rangeEnabled ? rangeEnd : timeEnd;
    setPlayheadTime((current) => Math.min(max, Math.max(min, current + delta)));
  };
  const jumpTo = (time: number) => setPlayheadTime(Math.min(timeEnd, Math.max(0, time)));
  const jumpToPreviousKey = () => jumpTo(Math.max(0, Math.ceil(playheadTime) - 1));
  const jumpToNextKey = () => jumpTo(Math.min(timeEnd, Math.floor(playheadTime) + 1));

  return (
    <section className="timeline-panel" aria-label="Timeline editor preview">
      <header className="timeline-panel__header">
        <div className="timeline-panel__tabs" role="tablist" aria-label="Bottom panel">
          <button className="timeline-panel__tab timeline-panel__tab--active" type="button" role="tab" aria-selected="true">
            <span className="timeline-panel__title-icon">◆</span>
            Timeline
          </button>
          <button
            className="timeline-panel__tab"
            type="button"
            role="tab"
            aria-selected="false"
            onClick={() => window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }))}
          >
            Console
          </button>
        </div>
        <div className="timeline-panel__toolbar">
          <div className="timeline-panel__tools">
          <button className="timeline-transport" type="button" aria-label="Go to start" onClick={() => jumpTo(0)}>◀|</button>
          <button className="timeline-transport" type="button" aria-label="Previous key" onClick={jumpToPreviousKey}>◆◀</button>
          <button className="timeline-transport" type="button" aria-label="Previous frame" onClick={() => nudgePlayhead(-1 / 24)}>◀</button>
          <button
            className="timeline-transport timeline-transport--play"
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            aria-pressed={isPlaying}
            onClick={() => setIsPlaying((playing) => !playing)}
          >
            {isPlaying ? "Ⅱ" : "▶"}
          </button>
          <button className="timeline-transport" type="button" aria-label="Next frame" onClick={() => nudgePlayhead(1 / 24)}>▶</button>
          <button className="timeline-transport" type="button" aria-label="Next key" onClick={jumpToNextKey}>▶◆</button>
          <button className="timeline-transport" type="button" aria-label="Go to end" onClick={() => jumpTo(timeEnd)}>▶|</button>
          <button
            className={`timeline-transport${loop ? " timeline-tool--active" : ""}`}
            type="button"
            aria-label="Loop"
            aria-pressed={loop}
            onClick={() => setLoop((enabled) => !enabled)}
          >↔</button>
          <span className="timeline-panel__frame">{String(Math.round(playheadTime * 24)).padStart(4, "0")} / {String(Math.round(timeEnd * 24)).padStart(4, "0")}</span>
          <span className="timeline-panel__divider" />
          <button className="timeline-tool timeline-tool--active" type="button">Select</button>
          <button className="timeline-tool" type="button" disabled title="Snapping is preview-only">Snap</button>
          <button
            className={`timeline-tool timeline-tool--range${rangeEnabled ? " timeline-tool--active" : ""}`}
            type="button"
            aria-pressed={rangeEnabled}
            onClick={() => setRangeEnabled((enabled) => !enabled)}
          >
            Range
          </button>
          </div>
          <div className="timeline-panel__readout">
            <span className="timeline-panel__status-dot" />
            <span>{playheadTime.toFixed(2)} s</span>
            <span className="timeline-panel__fps">24 fps</span>
            <label className="timeline-panel__zoom">
              Zoom
              <input
                aria-label="Timeline zoom"
                type="range"
                min="12"
                max="180"
                value={pixelsPerSecond}
                onChange={(event) => setPixelsPerSecond(Number(event.currentTarget.value))}
              />
            </label>
            <label className="timeline-panel__range-field">
              <span>Range</span>
              <input
                aria-label="Range start"
                type="number"
                min="0"
                max={rangeEnd}
                step="0.1"
                value={rangeStart}
                disabled={!rangeEnabled}
                onChange={(event) => setRangeStart(Math.max(0, Math.min(rangeEnd - 0.1, event.currentTarget.valueAsNumber || 0)))}
              />
              <span>–</span>
              <input
                aria-label="Range end"
                type="number"
                min={rangeStart + 0.1}
                max={timeEnd}
                step="0.1"
                value={rangeEnd}
                disabled={!rangeEnabled}
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
        <div className="timeline-panel__ruler-viewport">
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
            <div
              className="timeline-panel__ruler-playhead"
              style={{ left: Math.min(playheadTime, timeEnd) * pixelsPerSecond }}
            />
          </div>
        </div>

        <div className="timeline-panel__tree-viewport">
          <div ref={treeRowsRef} style={{ height: rows.length * ROW_HEIGHT }}>
            {rows.map((row) => {
              const binding = row.bindingId ? bindingById.get(row.bindingId) : undefined;
              return (
                <div
                  className={`timeline-row timeline-row--${row.kind}`}
                  key={row.id}
                  style={{ height: ROW_HEIGHT, paddingLeft: 10 + row.depth * 15 }}
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

        <div className="timeline-panel__canvas-viewport" ref={canvasViewportRef} onScroll={handleScroll}>
          <canvas ref={canvasRef} aria-label="Timeline tracks" />
        </div>
      </div>
    </section>
  );
}
