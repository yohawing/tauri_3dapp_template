import { invoke } from "@tauri-apps/api/core";
import { isFiniteF32 } from "../wireValidation";

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
  | { type: "pointerCancel" }
  | { type: "wheel"; dx: number; dy: number; modifiers: number };

const MAX_VIEWPORT_COORDINATE = 1_000_000;
const MAX_VIEWPORT_WHEEL_DELTA = 100_000;
/** Bound the ordered IPC tail while a transport request is stalled. */
export const MAX_PENDING_VIEWPORT_INPUTS = 256;
/** Allow Native one MainEventsCleared cadence to drain before retrying a full queue. */
export const VIEWPORT_INPUT_RETRY_DELAY_MS = 20;

function isViewportCoordinate(value: number): boolean {
  return isFiniteF32(value) && Math.abs(value) <= MAX_VIEWPORT_COORDINATE;
}

function isViewportWheelDelta(value: number): boolean {
  return isFiniteF32(value) && Math.abs(value) <= MAX_VIEWPORT_WHEEL_DELTA;
}

// Outside a real Tauri runtime (e.g. plain `vite dev` in a browser tab)
// `invoke` rejects for every call. Log once instead of spamming the console
// on every pointermove/wheel frame — same pattern as set_viewport_rect.
let hasWarnedAboutMissingTauri = false;

function isViewportQueueFullError(error: unknown): boolean {
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.includes("viewport input queue is full");
}

export async function sendViewportInput(
  input: ViewportInput,
  retryQueueFull = false,
  shouldRetry: () => boolean = () => true,
): Promise<void> {
  for (let attempt = 0; attempt < (retryQueueFull ? 2 : 1); attempt += 1) {
    try {
      await invoke("viewport_input", { input });
      return;
    } catch (err) {
      if (attempt === 0 && retryQueueFull && isViewportQueueFullError(err) && shouldRetry()) {
        await new Promise<void>((resolve) => setTimeout(resolve, VIEWPORT_INPUT_RETRY_DELAY_MS));
        if (!shouldRetry()) return;
        continue;
      }
      if (!hasWarnedAboutMissingTauri) {
        hasWarnedAboutMissingTauri = true;
        console.warn(
          "[ViewportInput] viewport_input invoke failed once (expected when " +
            "running outside the Tauri shell, e.g. plain `vite dev`):",
          err,
        );
      }
      return;
    }
  }
}

let currentViewportInputAttachmentGeneration = 0;
let currentViewportInputIdle: (() => Promise<void>) | null = null;

/**
 * Fences commands that depend on completed pointer gestures (notably Undo).
 * Resolving means the current attachment's PointerUp has reached the native
 * input queue; the renderer then processes that queue before history requests.
 */
export function waitForViewportInputIdle(): Promise<void> {
  return currentViewportInputIdle?.() ?? Promise.resolve();
}

interface OrderedViewportInputTail {
  enqueue(input: ViewportInput, shouldSend?: () => boolean, force?: boolean): void;
  cancel(dropPending?: boolean): void;
  idle(): Promise<void>;
}

/** Serializes input IPC while allowing queued non-boundary work to be dropped. */
function createOrderedViewportInputTail(): OrderedViewportInputTail {
  interface PendingViewportInput {
    input: ViewportInput;
    shouldSend: () => boolean;
    force: boolean;
  }

  const pending: PendingViewportInput[] = [];
  let active: Promise<void> | null = null;
  let idleWaiters: Array<() => void> = [];
  let cancelled = false;
  let dropPending = false;
  let pendingForces = 0;
  let forceQueuedType: ViewportInput["type"] | null = null;

  const settleIdle = () => {
    if (active !== null || pending.length !== 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  };

  const pump = () => {
    if (active !== null) return;
    const next = pending.shift();
    if (!next) {
      settleIdle();
      return;
    }
    active = Promise.resolve()
      .then(async () => {
        if ((dropPending && !next.force) || !next.shouldSend()) return;
        await sendViewportInput(next.input, next.force, next.shouldSend);
      })
      .catch(() => undefined)
      .finally(() => {
        if (next.force) {
          pendingForces -= 1;
          if (forceQueuedType === next.input.type) forceQueuedType = null;
          if (pendingForces === 0) dropPending = false;
        }
        active = null;
        pump();
      });
  };

  return {
    enqueue: (input, shouldSend = () => true, force = false) => {
      if (cancelled && !force) return;
      if (force && forceQueuedType === input.type) return;
      if (!force) {
        const latest = pending.at(-1);
        if (latest && !latest.force && latest.input.type === input.type) {
          if (latest.input.type === "wheel" && input.type === "wheel") {
            latest.input = {
              type: "wheel",
              dx: Math.max(-MAX_VIEWPORT_WHEEL_DELTA, Math.min(MAX_VIEWPORT_WHEEL_DELTA, latest.input.dx + input.dx)),
              dy: Math.max(-MAX_VIEWPORT_WHEEL_DELTA, Math.min(MAX_VIEWPORT_WHEEL_DELTA, latest.input.dy + input.dy)),
              modifiers: input.modifiers,
            };
          } else {
            latest.input = input;
          }
          latest.shouldSend = shouldSend;
          return;
        }
        if (pending.length >= MAX_PENDING_VIEWPORT_INPUTS) return;
      }
      if (force) {
        forceQueuedType = input.type;
        pendingForces += 1;
        if (pending.length >= MAX_PENDING_VIEWPORT_INPUTS) dropPending = true;
      }
      pending.push({ input, shouldSend, force });
      pump();
    },
    cancel: (shouldDropPending = true) => {
      cancelled = true;
      if (shouldDropPending) {
        dropPending = true;
      }
    },
    idle: () => {
      if (active === null && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
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

function isViewportUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-viewport-ui]") !== null;
}

/**
 * Wires pointer/wheel listeners on `el` and forwards them to Rust via
 * sendViewportInput. Coordinates are CSS px local to `el` (clientX/Y minus
 * the element's current bounding rect origin), matching the fixed contract.
 *
 * Returns an attachment whose `detach` removes all listeners and cancels any
 * pending rAF-coalesced pointermove. Detach also terminates the native gesture
 * so a backend switch cannot leave Orbit or the manipulator armed; `idle`
 * fences the ordered IPC tail for that detach.
 */
export interface ViewportInputAttachment {
  detach(): void;
  /** Resolves after every input IPC request currently queued by this attachment. */
  idle(): Promise<void>;
}

export function attachViewportInput(el: HTMLElement): ViewportInputAttachment {
  const attachmentGeneration = ++currentViewportInputAttachmentGeneration;
  let moveRafId: number | null = null;
  let pendingMove: ViewportInput | null = null;
  let pendingMoveEpoch = 0;
  let gestureEpoch = 0;
  let cancelledThroughEpoch = -1;
  const dispatchTail = createOrderedViewportInputTail();
  let activePointerId: number | null = null;
  let attached = true;

  // `invoke` is asynchronous and its completion order is not a wire-order
  // guarantee. Keep one ordered tail for boundaries while still coalescing
  // ordinary moves. A canceled epoch is dropped if it was queued but had not
  // reached `sendViewportInput` yet.
  function enqueue(input: ViewportInput, epoch = gestureEpoch, force = false) {
    dispatchTail.enqueue(
      input,
      () =>
        attachmentGeneration === currentViewportInputAttachmentGeneration &&
        (force ||
          (attached && !(input.type === "pointerMove" && epoch <= cancelledThroughEpoch))),
      force,
    );
  }

  // pointermove fires far faster than we can usefully forward over IPC and
  // faster than the native renderer can consume. Keep only the latest event
  // per frame ("latest-value-wins") and flush at most once per rAF.
  function flushPendingMove() {
    moveRafId = null;
    if (pendingMove) {
      const move = pendingMove;
      const epoch = pendingMoveEpoch;
      pendingMove = null;
      enqueue(move, epoch);
    }
  }

  function scheduleMove(input: ViewportInput) {
    pendingMove = input;
    pendingMoveEpoch = gestureEpoch;
    if (moveRafId === null) {
      moveRafId = requestAnimationFrame(flushPendingMove);
    }
  }

  function localPoint(e: PointerEvent): { x: number; y: number } | null {
    // Prefer coordinates already expressed in the ViewportHost's own padding
    // box. This avoids crossing WKWebView's window/client coordinate boundary
    // on macOS, where a translated WebView can otherwise leave a constant
    // full-window offset in native gizmo picking.
    if (
      e.target === el &&
      isViewportCoordinate(e.offsetX) &&
      isViewportCoordinate(e.offsetY)
    ) {
      return { x: e.offsetX, y: e.offsetY };
    }
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return isViewportCoordinate(x) && isViewportCoordinate(y) ? { x, y } : null;
  }

  function onPointerDown(e: PointerEvent) {
    if (isViewportUiTarget(e.target)) return;
    const point = localPoint(e);
    if (!point) return;
    if (activePointerId !== null && activePointerId !== e.pointerId) {
      // A second pointer cannot continue the first native gesture. End the
      // old one before accepting this down event.
      if (el.hasPointerCapture(activePointerId)) {
        el.releasePointerCapture(activePointerId);
      }
      cancelGesture();
    }
    activePointerId = e.pointerId;
    el.setPointerCapture(e.pointerId);
    // Avoid text selection / native context-menu weirdness while dragging.
    e.preventDefault();
    const { x, y } = point;
    enqueue(
      {
        type: "pointerDown",
        x,
        y,
        button: e.button,
        modifiers: modifiersFromEvent(e),
      },
      gestureEpoch,
      true,
    );
  }

  function onPointerMove(e: PointerEvent) {
    if (isViewportUiTarget(e.target)) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    // Chromium may emit one final move with `buttons === 0` immediately before
    // pointerup. Do not forward that as a drag update: PointerUp is the only
    // commit boundary, while PointerCancel/Escape are the only rollback
    // boundaries. Treating this release move as cancel used to erase the drag
    // before PointerUp could add its single history entry.
    if (activePointerId !== null && e.buttons === 0) return;
    // Pointer moves with no buttons after a completed gesture are hover
    // events. Forward them through the same latest-value queue so Native can
    // update manipulator highlighting without resurrecting an old gesture.
    const point = localPoint(e);
    if (!point) {
      dropPendingMove();
      return;
    }
    const { x, y } = point;
    scheduleMove({
      type: "pointerMove",
      x,
      y,
      buttons: e.buttons,
      modifiers: modifiersFromEvent(e),
    });
  }

  function finishPointer(e: PointerEvent, kind: "up" | "cancel") {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    if (isViewportUiTarget(e.target) && !el.hasPointerCapture(e.pointerId)) return;
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    const point = localPoint(e);
    if (!point) {
      // A malformed terminal event must not leave Native dragging forever.
      cancelGesture();
      return;
    }
    const { x, y } = point;
    if (kind === "up") {
      // A final rAF move belongs before pointerup. This is deliberately not
      // done for cancel: detach/cancel must not manufacture a last transform.
      flushPendingMove();
    } else {
      dropPendingMove();
      cancelledThroughEpoch = Math.max(cancelledThroughEpoch, gestureEpoch);
    }
    activePointerId = null;
    enqueue(
      kind === "up"
        ? { type: "pointerUp", x, y, button: e.button, modifiers: modifiersFromEvent(e) }
        : { type: "pointerCancel" },
      gestureEpoch,
      true,
    );
    gestureEpoch += 1;
  }

  function onPointerUp(e: PointerEvent) {
    finishPointer(e, "up");
  }

  function onPointerCancel(e: PointerEvent) {
    finishPointer(e, "cancel");
  }

  function cancelGesture() {
    dropPendingMove();
    cancelledThroughEpoch = Math.max(cancelledThroughEpoch, gestureEpoch);
    activePointerId = null;
    enqueue({ type: "pointerCancel" }, gestureEpoch, true);
    gestureEpoch += 1;
  }

  function dropPendingMove() {
    pendingMove = null;
    if (moveRafId !== null) {
      cancelAnimationFrame(moveRafId);
      moveRafId = null;
    }
  }

  function onContextMenu(e: Event) {
    if (isViewportUiTarget(e.target)) return;
    e.preventDefault();
  }

  function onWheel(e: WheelEvent) {
    if (isViewportUiTarget(e.target)) return;
    // Stop page zoom/scroll from also reacting to wheel input over the
    // viewport — the native camera owns this gesture.
    e.preventDefault();
    if (!isViewportWheelDelta(e.deltaX) || !isViewportWheelDelta(e.deltaY)) return;
    enqueue({
      type: "wheel",
      dx: e.deltaX,
      dy: e.deltaY,
      modifiers: modifiersFromEvent(e),
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || activePointerId === null) return;
    const target = e.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) return;
    e.preventDefault();
    cancelGesture();
  }

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("contextmenu", onContextMenu);
  el.addEventListener("wheel", onWheel, { passive: false });
  const keyboardTarget = el.ownerDocument?.defaultView;
  keyboardTarget?.addEventListener("keydown", onKeyDown);

  function detach() {
    if (!attached) return;
    attached = false;
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    // The listeners above are stable closures for the lifetime of this
    // attachment; remove the event type by using the same handlers below.
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
    el.removeEventListener("contextmenu", onContextMenu);
    el.removeEventListener("wheel", onWheel);
    keyboardTarget?.removeEventListener("keydown", onKeyDown);
    if (activePointerId !== null && el.hasPointerCapture(activePointerId)) {
      el.releasePointerCapture(activePointerId);
    }
    cancelGesture();
    dispatchTail.cancel(false);
    if (attachmentGeneration === currentViewportInputAttachmentGeneration) {
      currentViewportInputIdle = null;
    }
  }

  const attachment = {
    detach,
    idle: dispatchTail.idle,
  };
  currentViewportInputIdle = attachment.idle;
  return attachment;
}

/** Cancels scripted input that has not completed yet. */
export interface ViewportInputSelfTestHandle {
  cancel(): void;
  idle(): Promise<void>;
}

interface ViewportInputSelfTestState {
  cancelled: boolean;
  completed: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  cancel: () => void;
}

let activeSelfTest: ViewportInputSelfTestState | null = null;
let selfTestCompleted = false;

const NOOP_SELF_TEST: ViewportInputSelfTestHandle = { cancel: () => undefined, idle: () => Promise.resolve() };

/**
 * Dev-only scripted input sequence, gated behind VITE_INPUT_SELF_TEST. Lets
 * an integration agent exercise the full IPC -> native camera path (via
 * screenshots taken around the timestamps below) without OS-level mouse
 * automation. Bypasses the DOM entirely and calls sendViewportInput
 * through an ordered input tail. A cancelled, incomplete run can be armed
 * again (for example by React StrictMode's probe mount); a completed run
 * remains one-shot.
 */
export function maybeRunViewportInputSelfTest(el: HTMLElement): ViewportInputSelfTestHandle {
  const cameraSelfTest = Boolean(import.meta.env.VITE_INPUT_SELF_TEST);
  const manipulatorSelfTest = import.meta.env.VITE_MANIPULATOR_SELF_TEST as
    | "translate"
    | "rotate"
    | "scale"
    | undefined;
  if (selfTestCompleted || activeSelfTest || (!cameraSelfTest && !manipulatorSelfTest)) {
    return NOOP_SELF_TEST;
  }

  const state: ViewportInputSelfTestState = {
    cancelled: false,
    completed: false,
    timers: new Set<ReturnType<typeof setTimeout>>(),
    cancel: () => undefined,
  };
  activeSelfTest = state;
  const dispatchTail = createOrderedViewportInputTail();

  const schedule = (callback: () => void, delayMs: number): void => {
    if (state.cancelled || state.completed) return;
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      if (!state.cancelled && !state.completed) callback();
    }, delayMs);
    state.timers.add(timer);
  };

  const complete = (): void => {
    if (state.cancelled) return;
    state.completed = true;
    selfTestCompleted = true;
    if (activeSelfTest === state) activeSelfTest = null;
  };

  const cancel = (): void => {
    if (state.cancelled) return;
    state.cancelled = true;
    state.timers.forEach((timer) => clearTimeout(timer));
    state.timers.clear();
    dispatchTail.cancel();
    if (activeSelfTest === state) activeSelfTest = null;
  };
  state.cancel = cancel;

  const rect = el.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  if (manipulatorSelfTest) {
    schedule(() => {
      const rotate = manipulatorSelfTest === "rotate";
      const startX = rotate ? cx + 62 : cx;
      const startY = cy;
      const endX = rotate ? startX : cx - 72;
      const endY = rotate ? cy + 48 : cy + 36;
      dispatchTail.enqueue({ type: "pointerDown", x: startX, y: startY, button: 0, modifiers: 0 });
      dispatchTail.enqueue({
        type: "pointerMove",
        x: endX,
        y: endY,
        buttons: 1,
        modifiers: 0,
      });
      dispatchTail.enqueue({ type: "pointerUp", x: endX, y: endY, button: 0, modifiers: 0 }, undefined, true);
      complete();
    }, 2500);
    return { cancel, idle: dispatchTail.idle };
  }

  // ~2.5s: left-drag orbit, +150px x / +60px y over ~1s.
  schedule(() => {
    const steps = 30;
    const durationMs = 1000;
    dispatchTail.enqueue({ type: "pointerDown", x: cx, y: cy, button: 0, modifiers: 0 });
    for (let i = 1; i <= steps; i++) {
      schedule(() => {
        const t = i / steps;
        dispatchTail.enqueue({
          type: "pointerMove",
          x: cx + 150 * t,
          y: cy + 60 * t,
          buttons: 1,
          modifiers: 0,
        });
        if (i === steps) {
          dispatchTail.enqueue({
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
  schedule(() => {
    for (let i = 0; i < 5; i++) {
      schedule(() => {
        dispatchTail.enqueue({ type: "wheel", dx: 0, dy: -120, modifiers: 0 });
      }, i * 100);
    }
  }, 4500);

  // ~6.0s: Shift+left-drag pan, +80px x / -40px y over ~0.8s.
  schedule(() => {
    const steps = 24;
    const durationMs = 800;
    const shift = 1;
    dispatchTail.enqueue({ type: "pointerDown", x: cx, y: cy, button: 0, modifiers: shift });
    for (let i = 1; i <= steps; i++) {
      schedule(() => {
        const t = i / steps;
        dispatchTail.enqueue({
          type: "pointerMove",
          x: cx + 80 * t,
          y: cy - 40 * t,
          buttons: 1,
          modifiers: shift,
        });
        if (i === steps) {
          dispatchTail.enqueue({
            type: "pointerUp",
            x: cx + 80,
            y: cy - 40,
            button: 0,
            modifiers: shift,
          });
        }
        if (i === steps) complete();
      }, (durationMs * i) / steps);
    }
  }, 6000);

  return { cancel, idle: dispatchTail.idle };
}

// Vite can replace this module without unmounting the current React tree.
// Cancel the old scripted tail before the replacement can arm a new run;
// otherwise HMR would briefly drive duplicate native input sequences.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeSelfTest?.cancel();
    activeSelfTest = null;
    selfTestCompleted = false;
  });
}
