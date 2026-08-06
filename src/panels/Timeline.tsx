import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { fixtureTimelineDataSource } from "../timeline/adapters/fixtureDataSource";
import {
  createViewTransform,
  type TimelineDataSource,
  type TimelineItem,
  type TimelineKey,
  type TimelineRow,
} from "../timeline/core/contracts";
import "./Timeline.css";

const ROW_HEIGHT = 34;
const TIME_END = 12;
const PIXELS_PER_SECOND = 104;
const CANVAS_WIDTH = TIME_END * PIXELS_PER_SECOND;
const PLAYHEAD_TIME = 4.55;

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
    roundedRect(context, x + 1, rowY + 6, width - 2, 22, 4);
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
    context.rect(x + 7, rowY + 6, Math.max(0, width - 14), 22);
    context.clip();
    context.fillStyle = "rgba(255, 255, 255, 0.9)";
    context.font = "500 10px Inter, Segoe UI, sans-serif";
    context.textBaseline = "middle";
    context.fillText(item.label, x + 8, rowY + 17);

    if (item.rowId === "row-audio") {
      context.strokeStyle = "rgba(218, 255, 244, 0.44)";
      context.lineWidth = 1;
      context.beginPath();
      for (let offset = 0; offset < width - 12; offset += 4) {
        const amplitude = 2 + Math.abs(Math.sin(offset * 0.17)) * 3;
        context.moveTo(x + 7 + offset, rowY + 17 - amplitude);
        context.lineTo(x + 7 + offset, rowY + 17 + amplitude);
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
    context.moveTo(x + 0.5, rowY + 9);
    context.lineTo(x + 0.5, rowY + 28);
    context.stroke();
    context.fillStyle = item.color;
    context.beginPath();
    context.moveTo(x - 5, rowY + 7);
    context.lineTo(x + 5, rowY + 7);
    context.lineTo(x, rowY + 13);
    context.closePath();
    context.fill();
  } else if (item.kind === "event-cue") {
    context.fillStyle = item.color;
    context.beginPath();
    context.moveTo(x, rowY + 7);
    context.lineTo(x + 6, rowY + 11);
    context.lineTo(x + 6, rowY + 19);
    context.lineTo(x, rowY + 23);
    context.lineTo(x - 6, rowY + 19);
    context.lineTo(x - 6, rowY + 11);
    context.closePath();
    context.fill();
  } else {
    context.fillStyle = item.color;
    context.beginPath();
    context.arc(x, rowY + 16, 5, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "rgba(238, 238, 244, 0.78)";
  context.font = "500 9px Inter, Segoe UI, sans-serif";
  context.textBaseline = "middle";
  context.fillText(item.label, x + 9, rowY + 17);
}

function drawKey(
  context: CanvasRenderingContext2D,
  key: TimelineKey,
  rowIndex: number,
  timeToX: (time: number) => number,
) {
  const x = timeToX(key.time);
  const y = rowIndex * ROW_HEIGHT + 25;
  drawDiamond(context, x, y, key.selected ? 4.5 : 3.5);
  context.fillStyle = key.selected ? "#ffffff" : "rgba(230, 232, 255, 0.78)";
  context.fill();
  context.strokeStyle = "rgba(24, 24, 31, 0.9)";
  context.lineWidth = 1;
  context.stroke();
}

function paintTimeline(
  canvas: HTMLCanvasElement,
  rows: readonly TimelineRow[],
  items: readonly TimelineItem[],
  keys: readonly TimelineKey[],
) {
  const height = rows.length * ROW_HEIGHT;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(CANVAS_WIDTH * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${CANVAS_WIDTH}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, CANVAS_WIDTH, height);

  rows.forEach((row, index) => {
    const y = index * ROW_HEIGHT;
    context.fillStyle =
      row.kind === "group"
        ? "#22242d"
        : index % 2 === 0
          ? "#1c1e25"
          : "#191b21";
    context.fillRect(0, y, CANVAS_WIDTH, ROW_HEIGHT);
    context.strokeStyle = "rgba(255, 255, 255, 0.055)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, y + ROW_HEIGHT - 0.5);
    context.lineTo(CANVAS_WIDTH, y + ROW_HEIGHT - 0.5);
    context.stroke();
  });

  for (let halfSecond = 0; halfSecond <= TIME_END * 2; halfSecond += 1) {
    const x = (halfSecond / 2) * PIXELS_PER_SECOND + 0.5;
    const major = halfSecond % 2 === 0;
    context.strokeStyle = major
      ? "rgba(255, 255, 255, 0.105)"
      : "rgba(255, 255, 255, 0.045)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  const transform = createViewTransform(0, PIXELS_PER_SECOND);
  const rowIndexById = new Map(rows.map((row, index) => [row.id, index]));
  for (const item of items) {
    const rowIndex = rowIndexById.get(item.rowId);
    if (rowIndex != null) drawItem(context, item, rowIndex, transform.timeToX);
  }
  for (const key of keys) {
    const rowIndex = rowIndexById.get(key.rowId);
    if (rowIndex != null) drawKey(context, key, rowIndex, transform.timeToX);
  }

  const playheadX = transform.timeToX(PLAYHEAD_TIME) + 0.5;
  context.strokeStyle = "#ff5d73";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(playheadX, 0);
  context.lineTo(playheadX, height);
  context.stroke();
}

export function Timeline({ dataSource = fixtureTimelineDataSource }: TimelineProps) {
  const revision = useSyncExternalStore(
    dataSource.subscribe,
    dataSource.getRevision,
    dataSource.getRevision,
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const treeRowsRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => dataSource.getRows({ start: 0, count: 10_000 }), [dataSource, revision]);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const items = useMemo(
    () => dataSource.getItems({ rowIds, range: { start: 0, end: TIME_END } }),
    [dataSource, revision, rowIds],
  );
  const keys = useMemo(
    () => dataSource.getKeys({ rowIds, range: { start: 0, end: TIME_END } }),
    [dataSource, revision, rowIds],
  );
  const bindingById = useMemo(
    () => new Map(dataSource.getBindings().map((binding) => [binding.id, binding])),
    [dataSource, revision],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => paintTimeline(canvas, rows, items, keys);
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [items, keys, rows]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (treeRowsRef.current) {
      treeRowsRef.current.style.transform = `translateY(${-target.scrollTop}px)`;
    }
    if (rulerRef.current) {
      rulerRef.current.style.transform = `translateX(${-target.scrollLeft}px)`;
    }
  };

  const ticks = Array.from({ length: TIME_END + 1 }, (_, second) => second);

  return (
    <section className="timeline-panel" aria-label="Timeline editor preview">
      <header className="timeline-panel__header">
        <div className="timeline-panel__title">
          <span className="timeline-panel__title-icon">◆</span>
          Timeline
        </div>
        <div className="timeline-panel__tools" aria-hidden="true">
          <button className="timeline-tool timeline-tool--active" type="button" tabIndex={-1}>Select</button>
          <button className="timeline-tool" type="button" tabIndex={-1}>Snap</button>
          <span className="timeline-panel__divider" />
          <button className="timeline-transport" type="button" tabIndex={-1}>◀</button>
          <button className="timeline-transport timeline-transport--play" type="button" tabIndex={-1}>▶</button>
          <button className="timeline-transport" type="button" tabIndex={-1}>▶|</button>
        </div>
        <div className="timeline-panel__readout">
          <span className="timeline-panel__status-dot" />
          <span>{PLAYHEAD_TIME.toFixed(2)} s</span>
          <span className="timeline-panel__fps">24 fps</span>
        </div>
      </header>

      <div className="timeline-panel__body">
        <div className="timeline-panel__tree-heading">
          <span>TRACKS</span>
          <span className="timeline-panel__tree-actions">＋ ⋯</span>
        </div>
        <div className="timeline-panel__ruler-viewport">
          <div className="timeline-panel__ruler" ref={rulerRef} style={{ width: CANVAS_WIDTH }}>
            {ticks.map((second) => (
              <div
                className="timeline-panel__tick"
                key={second}
                style={{ left: second * PIXELS_PER_SECOND }}
              >
                <span>{String(second).padStart(2, "0")}:00</span>
              </div>
            ))}
            <div
              className="timeline-panel__ruler-playhead"
              style={{ left: PLAYHEAD_TIME * PIXELS_PER_SECOND }}
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

        <div className="timeline-panel__canvas-viewport" onScroll={handleScroll}>
          <canvas ref={canvasRef} aria-label="Timeline tracks" />
        </div>
      </div>
    </section>
  );
}
