import { useRef } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import "./RangeViewport.css";

export interface RangeViewportValue {
  start: number;
  end: number;
}

export interface RangeViewportProps {
  start: number;
  end: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  "aria-label"?: string;
  onChange: (value: RangeViewportValue) => void;
}

type Handle = "start" | "end";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snap(value: number, min: number, max: number, step: number) {
  const snapped = min + Math.round((value - min) / step) * step;
  return clamp(Number(snapped.toFixed(4)), min, max);
}

export function RangeViewport({
  start,
  end,
  min = 0,
  max = 100,
  step = 0.5,
  disabled = false,
  "aria-label": ariaLabel = "Range viewport",
  onChange,
}: RangeViewportProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const activeHandle = useRef<Handle | null>(null);
  const span = Math.max(step, max - min);
  const safeStart = clamp(start, min, max - step);
  const safeEnd = clamp(end, safeStart + step, max);

  const emit = (handle: Handle, value: number) => {
    const next = snap(value, min, max, step);
    if (handle === "start") {
      onChange({ start: Math.min(next, safeEnd - step), end: safeEnd });
    } else {
      onChange({ start: safeStart, end: Math.max(next, safeStart + step) });
    }
  };

  const valueFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track) return min;
    const bounds = track.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0;
    return min + clamp(ratio, 0, 1) * span;
  };

  const handlePointerDown = (handle: Handle) => (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    activeHandle.current = handle;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const handle = activeHandle.current;
    if (handle) emit(handle, valueFromPointer(event as unknown as PointerEvent<HTMLDivElement>));
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    activeHandle.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.target !== event.currentTarget) return;
    const value = valueFromPointer(event);
    const handle = Math.abs(value - safeStart) <= Math.abs(value - safeEnd) ? "start" : "end";
    emit(handle, value);
  };

  const handleKeyDown = (handle: Handle) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const current = handle === "start" ? safeStart : safeEnd;
    const delta = event.shiftKey ? step * 10 : step;
    let next = current;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= delta;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next += delta;
    if (event.key === "Home") next = min;
    if (event.key === "End") next = max;
    if (next === current) return;
    event.preventDefault();
    emit(handle, next);
  };

  const startPercent = ((safeStart - min) / span) * 100;
  const endPercent = ((safeEnd - min) / span) * 100;

  return (
    <div
      className={`range-viewport${disabled ? " is-disabled" : ""}`}
      role="group"
      aria-label={ariaLabel}
    >
      <div
        className="range-viewport__track"
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
      >
        <button
          className="range-viewport__handle range-viewport__handle--start"
          type="button"
          role="slider"
          aria-label="Range viewport start"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={safeStart}
          aria-valuetext={`${safeStart.toFixed(1)}%`}
          tabIndex={disabled ? -1 : 0}
          disabled={disabled}
          style={{ left: `${startPercent}%` }}
          onPointerDown={handlePointerDown("start")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown("start")}
        />
        <button
          className="range-viewport__handle range-viewport__handle--end"
          type="button"
          role="slider"
          aria-label="Range viewport end"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={safeEnd}
          aria-valuetext={`${safeEnd.toFixed(1)}%`}
          tabIndex={disabled ? -1 : 0}
          disabled={disabled}
          style={{ left: `${endPercent}%` }}
          onPointerDown={handlePointerDown("end")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown("end")}
        />
      </div>
    </div>
  );
}
