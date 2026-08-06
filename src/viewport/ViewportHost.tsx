import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { attachViewportInput, maybeRunViewportInputSelfTest } from "./input";

/**
 * Fixed IPC contract shared with the Rust side. Do not change field names or
 * shape without coordinating — src-tauri is coding against exactly this.
 */
interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

// Outside a real Tauri runtime (e.g. plain `vite dev` in a browser tab)
// `invoke` rejects for every call. Log once instead of spamming the console
// on every resize frame.
let hasWarnedAboutMissingTauri = false;

async function sendViewportRect(rect: ViewportRect): Promise<void> {
  try {
    await invoke("set_viewport_rect", { rect });
  } catch (err) {
    if (!hasWarnedAboutMissingTauri) {
      hasWarnedAboutMissingTauri = true;
      console.warn(
        "[ViewportHost] set_viewport_rect invoke failed once (expected when " +
          "running outside the Tauri shell, e.g. plain `vite dev`):",
        err,
      );
    }
  }
}

/**
 * Central transparent hole in the DOM. The native wgpu renderer draws behind
 * the WebView here; this component's only jobs are to (a) stay visually
 * transparent and (b) keep Rust informed of its on-screen rectangle so the
 * native renderer can size its viewport/scissor to match.
 */
export function ViewportHost() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const [lastRect, setLastRect] = useState<ViewportRect | null>(null);

  // Coalesces any number of triggers (ResizeObserver, window resize, DPI
  // change) into at most one measurement + invoke per animation frame.
  const scheduleMeasure = useCallback(() => {
    if (rafIdRef.current !== null) {
      return;
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = hostRef.current;
      if (!el) {
        return;
      }
      const domRect = el.getBoundingClientRect();
      const rect: ViewportRect = {
        x: domRect.x,
        y: domRect.y,
        width: domRect.width,
        height: domRect.height,
        scaleFactor: window.devicePixelRatio,
      };
      setLastRect(rect);
      void sendViewportRect(rect);
    });
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) {
      return;
    }

    scheduleMeasure();

    const resizeObserver = new ResizeObserver(() => {
      scheduleMeasure();
    });
    resizeObserver.observe(el);

    window.addEventListener("resize", scheduleMeasure);

    // There's no direct "devicePixelRatio changed" event, so we re-arm a
    // matchMedia query tuned to the current DPR each time it fires. This
    // catches the window being dragged to a monitor with a different scale
    // factor, or the OS display scale being changed.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      scheduleMeasure();
      armDprWatcher();
    };
    function armDprWatcher() {
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDprChange);
    }
    armDprWatcher();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      dprQuery?.removeEventListener("change", onDprChange);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [scheduleMeasure]);

  // Forward pointer/wheel input on the same host element to Rust so the
  // native orbit camera can be driven. Independent of the rect-reporting
  // effect above; cleaned up on unmount.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) {
      return;
    }
    const detach = attachViewportInput(el);
    maybeRunViewportInputSelfTest(el);
    return detach;
  }, []);

  return (
    <div ref={hostRef} className="viewport-host">
      <div className="viewport-host__overlay">
        <div className="viewport-host__label">Native wgpu viewport</div>
        {lastRect && (
          <div className="viewport-host__rect">
            x: {lastRect.x.toFixed(1)} y: {lastRect.y.toFixed(1)} w:{" "}
            {lastRect.width.toFixed(1)} h: {lastRect.height.toFixed(1)} dpr:{" "}
            {lastRect.scaleFactor.toFixed(2)}
          </div>
        )}
        <div className="viewport-host__hint">
          Drag: orbit · Shift+Drag: pan · Wheel: zoom
        </div>
      </div>
    </div>
  );
}
