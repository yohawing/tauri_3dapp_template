import { invoke } from "@tauri-apps/api/core";

/**
 * Fixed IPC contract shared with the Rust side. Do not change field names,
 * variant names, or the bitfield semantics without coordinating — src-tauri
 * is coding against exactly this shape. Adding a new input kind is meant to
 * be a single new union member plus a single new call site below.
 */
export type ViewportInput =
  | { type: "pointerMove"; x: number; y: number; buttons: number; modifiers: number }
  | { type: "pointerDown"; x: number; y: number; button: number; modifiers: number }
  | { type: "pointerUp"; x: number; y: number; button: number; modifiers: number }
  | { type: "wheel"; dx: number; dy: number; modifiers: number };

// Outside a real Tauri runtime (e.g. plain `vite dev` in a browser tab)
// `invoke` rejects for every call. Log once instead of spamming the console
// on every pointermove/wheel frame — same pattern as set_viewport_rect.
let hasWarnedAboutMissingTauri = false;

export async function sendViewportInput(input: ViewportInput): Promise<void> {
  try {
    await invoke("viewport_input", { input });
  } catch (err) {
    if (!hasWarnedAboutMissingTauri) {
      hasWarnedAboutMissingTauri = true;
      console.warn(
        "[ViewportInput] viewport_input invoke failed once (expected when " +
          "running outside the Tauri shell, e.g. plain `vite dev`):",
        err,
      );
    }
  }
}

// modifiers bitfield: 1=Shift, 2=Ctrl, 4=Alt, 8=Meta.
function modifiersFromEvent(e: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): number {
  let modifiers = 0;
  if (e.shiftKey) modifiers |= 1;
  if (e.ctrlKey) modifiers |= 2;
  if (e.altKey) modifiers |= 4;
  if (e.metaKey) modifiers |= 8;
  return modifiers;
}

/**
 * Wires pointer/wheel listeners on `el` and forwards them to Rust via
 * sendViewportInput. Coordinates are CSS px local to `el` (clientX/Y minus
 * the element's current bounding rect origin), matching the fixed contract.
 *
 * Returns a cleanup function that removes all listeners and cancels any
 * pending rAF-coalesced pointermove.
 */
export function attachViewportInput(el: HTMLElement): () => void {
  let moveRafId: number | null = null;
  let pendingMove: ViewportInput | null = null;

  // pointermove fires far faster than we can usefully forward over IPC and
  // faster than the native renderer can consume. Keep only the latest event
  // per frame ("latest-value-wins") and flush at most once per rAF.
  function flushPendingMove() {
    moveRafId = null;
    if (pendingMove) {
      const move = pendingMove;
      pendingMove = null;
      void sendViewportInput(move);
    }
  }

  function scheduleMove(input: ViewportInput) {
    pendingMove = input;
    if (moveRafId === null) {
      moveRafId = requestAnimationFrame(flushPendingMove);
    }
  }

  function localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: PointerEvent) {
    el.setPointerCapture(e.pointerId);
    // Avoid text selection / native context-menu weirdness while dragging.
    e.preventDefault();
    const { x, y } = localPoint(e);
    void sendViewportInput({
      type: "pointerDown",
      x,
      y,
      button: e.button,
      modifiers: modifiersFromEvent(e),
    });
  }

  function onPointerMove(e: PointerEvent) {
    const { x, y } = localPoint(e);
    scheduleMove({
      type: "pointerMove",
      x,
      y,
      buttons: e.buttons,
      modifiers: modifiersFromEvent(e),
    });
  }

  function onPointerUpOrCancel(e: PointerEvent) {
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    const { x, y } = localPoint(e);
    void sendViewportInput({
      type: "pointerUp",
      x,
      y,
      button: e.button,
      modifiers: modifiersFromEvent(e),
    });
  }

  function onContextMenu(e: Event) {
    e.preventDefault();
  }

  function onWheel(e: WheelEvent) {
    // Stop page zoom/scroll from also reacting to wheel input over the
    // viewport — the native camera owns this gesture.
    e.preventDefault();
    void sendViewportInput({
      type: "wheel",
      dx: e.deltaX,
      dy: e.deltaY,
      modifiers: modifiersFromEvent(e),
    });
  }

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUpOrCancel);
  el.addEventListener("pointercancel", onPointerUpOrCancel);
  el.addEventListener("contextmenu", onContextMenu);
  el.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUpOrCancel);
    el.removeEventListener("pointercancel", onPointerUpOrCancel);
    el.removeEventListener("contextmenu", onContextMenu);
    el.removeEventListener("wheel", onWheel);
    if (moveRafId !== null) {
      cancelAnimationFrame(moveRafId);
      moveRafId = null;
    }
  };
}

let selfTestHasRun = false;

/**
 * Dev-only scripted input sequence, gated behind VITE_INPUT_SELF_TEST. Lets
 * an integration agent exercise the full IPC -> native camera path (via
 * screenshots taken around the timestamps below) without OS-level mouse
 * automation. Bypasses the DOM entirely and calls sendViewportInput
 * directly. Runs at most once per page load.
 */
export function maybeRunViewportInputSelfTest(el: HTMLElement): void {
  if (selfTestHasRun || !import.meta.env.VITE_INPUT_SELF_TEST) {
    return;
  }
  selfTestHasRun = true;

  const rect = el.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  // ~2.5s: left-drag orbit, +150px x / +60px y over ~1s.
  setTimeout(() => {
    const steps = 30;
    const durationMs = 1000;
    void sendViewportInput({ type: "pointerDown", x: cx, y: cy, button: 0, modifiers: 0 });
    for (let i = 1; i <= steps; i++) {
      setTimeout(() => {
        const t = i / steps;
        void sendViewportInput({
          type: "pointerMove",
          x: cx + 150 * t,
          y: cy + 60 * t,
          buttons: 1,
          modifiers: 0,
        });
        if (i === steps) {
          void sendViewportInput({
            type: "pointerUp",
            x: cx + 150,
            y: cy + 60,
            button: 0,
            modifiers: 0,
          });
        }
      }, (durationMs * i) / steps);
    }
  }, 2500);

  // ~4.5s: 5 wheel events, dy:-120 spaced 100ms apart (zoom in).
  setTimeout(() => {
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        void sendViewportInput({ type: "wheel", dx: 0, dy: -120, modifiers: 0 });
      }, i * 100);
    }
  }, 4500);
}
