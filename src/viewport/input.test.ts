import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  attachViewportInput,
  maybeRunViewportInputSelfTest,
  MAX_PENDING_VIEWPORT_INPUTS,
  sendViewportInput,
  VIEWPORT_INPUT_RETRY_DELAY_MS,
  waitForViewportInputIdle,
} from "./input";

type Listener = (event: Event) => void;

class FakeElement {
  private readonly listeners = new Map<string, Listener>();
  private readonly captures = new Set<number>();

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener as Listener);
  }

  public removeEventListener(type: string) {
    this.listeners.delete(type);
  }

  public dispatch(type: string, event: Record<string, unknown> = {}) {
    const listener = this.listeners.get(type);
    if (!listener) return;
    listener({ target: this, ...event } as unknown as Event);
  }

  public getBoundingClientRect() {
    return { left: 10, top: 20, width: 320, height: 240 } as DOMRect;
  }

  public setPointerCapture(pointerId: number) {
    this.captures.add(pointerId);
  }

  public hasPointerCapture(pointerId: number) {
    return this.captures.has(pointerId);
  }

  public releasePointerCapture(pointerId: number) {
    this.captures.delete(pointerId);
  }
}

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    pointerId: 1,
    clientX: 30,
    clientY: 40,
    button: 0,
    buttons: 1,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleEventLoop() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function settleMicrotasks() {
  for (let index = 0; index < 32; index += 1) {
    await Promise.resolve();
  }
}

function receivedInputs(): Array<{ type: string; [key: string]: unknown }> {
  return (invoke.mock.calls as unknown as Array<[string, { input: { type: string; [key: string]: unknown } }]>).map(
    ([, args]) => args.input,
  );
}

describe("attachViewportInput gesture boundaries", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve());
    rafCallbacks = [];
    vi.stubGlobal("Element", class {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafCallbacks[id - 1] = () => undefined;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a fast click ordered as down then up", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    el.dispatch("pointerup", pointer({ buttons: 0 }));
    await settleEventLoop();

    const commands = (invoke.mock.calls as unknown as Array<[string]>).map(([command]) => command);
    expect(commands.map((command, index) => [command, receivedInputs()[index]?.type])).toEqual([
      ["viewport_input", "pointerDown"],
      ["viewport_input", "pointerUp"],
    ]);
  });

  it("prefers viewport-local offsets over full-window client coordinates", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer({
      clientX: 430,
      clientY: 340,
      offsetX: 17,
      offsetY: 29,
    }));
    await settleEventLoop();

    expect(receivedInputs()).toEqual([
      { type: "pointerDown", x: 17, y: 29, button: 0, modifiers: 0 },
    ]);
  });

  it("drops malformed pointer coordinates while accepting the Rust boundary", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer({ clientX: Number.NaN }));
    el.dispatch("pointerdown", pointer({ clientX: Number.POSITIVE_INFINITY }));
    el.dispatch("pointerdown", pointer({ clientX: 1_000_011 }));
    el.dispatch("pointerdown", pointer({ clientX: 1_000_010 }));
    el.dispatch("pointerup", pointer({ clientX: -999_990, buttons: 0 }));
    await settleEventLoop();

    expect(receivedInputs()).toEqual([
      { type: "pointerDown", x: 1_000_000, y: 20, button: 0, modifiers: 0 },
      { type: "pointerUp", x: -1_000_000, y: 20, button: 0, modifiers: 0 },
    ]);
  });

  it("cancels a gesture when its terminal coordinates are malformed", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    el.dispatch("pointerup", pointer({ clientX: Number.NaN, buttons: 0 }));
    await settleEventLoop();

    expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerCancel"]);
  });

  it("drops malformed wheel deltas while accepting the Rust boundary", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    const wheel = (deltaX: number, deltaY: number) =>
      el.dispatch("wheel", {
        deltaX,
        deltaY,
        preventDefault: vi.fn(),
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    wheel(Number.NaN, 0);
    wheel(Number.NEGATIVE_INFINITY, 0);
    wheel(100_001, 0);
    wheel(100_000, -100_000);
    await settleEventLoop();

    expect(receivedInputs()).toEqual([
      { type: "wheel", dx: 100_000, dy: -100_000, modifiers: 0 },
    ]);
  });

  it("coalesces wheel IPC while the first transport request is stalled", async () => {
    const request = deferred<void>();
    let calls = 0;
    invoke.mockImplementation(() => (calls++ === 0 ? request.promise : Promise.resolve()));
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    const wheel = (deltaY: number) =>
      el.dispatch("wheel", {
        deltaX: 0,
        deltaY,
        preventDefault: vi.fn(),
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });

    wheel(1);
    for (let index = 0; index < MAX_PENDING_VIEWPORT_INPUTS + 32; index += 1) wheel(index + 2);
    await settleEventLoop();
    expect(calls).toBe(1);

    request.resolve();
    await attachment.idle();
    expect(calls).toBe(2);
    expect(receivedInputs()[1]).toEqual({
      type: "wheel",
      dx: 0,
      dy: 41_904,
      modifiers: 0,
    });
    wheel(999);
    await settleEventLoop();
    expect(calls).toBe(3);
    attachment.detach();
  });

  it("preserves a new gesture boundary after a coalesced wheel backlog", async () => {
    const request = deferred<void>();
    let calls = 0;
    invoke.mockImplementation(() => (calls++ === 0 ? request.promise : Promise.resolve()));
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    const wheel = (deltaY: number) =>
      el.dispatch("wheel", {
        deltaX: 0,
        deltaY,
        preventDefault: vi.fn(),
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });

    wheel(1);
    await settleEventLoop();
    for (let index = 0; index < MAX_PENDING_VIEWPORT_INPUTS - 1; index += 1) wheel(index + 2);
    el.dispatch("pointerdown", pointer());
    el.dispatch("pointerup", pointer({ buttons: 0 }));

    request.resolve();
    await attachment.idle();
    expect(receivedInputs().map(({ type }) => type)).toEqual([
      "wheel",
      "wheel",
      "pointerDown",
      "pointerUp",
    ]);
    expect(calls).toBe(4);
    attachment.detach();
  });

  it("keeps a coalesced wheel before the terminal pointer event", async () => {
    const request = deferred<void>();
    let calls = 0;
    invoke.mockImplementation(() => (calls++ === 0 ? request.promise : Promise.resolve()));
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    await settleEventLoop();
    const wheel = (deltaY: number) =>
      el.dispatch("wheel", {
        deltaX: 0,
        deltaY,
        preventDefault: vi.fn(),
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    for (let index = 0; index < MAX_PENDING_VIEWPORT_INPUTS; index += 1) wheel(index + 1);
    el.dispatch("pointerup", pointer({ buttons: 0 }));

    request.resolve();
    await attachment.idle();
    expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "wheel", "pointerUp"]);
    expect(calls).toBe(3);
    attachment.detach();
  });

  it("keeps multi-pointer cancellation after a coalesced wheel backlog", async () => {
    const request = deferred<void>();
    let calls = 0;
    invoke.mockImplementation(() => (calls++ === 0 ? request.promise : Promise.resolve()));
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    const wheel = (deltaY: number) =>
      el.dispatch("wheel", {
        deltaX: 0,
        deltaY,
        preventDefault: vi.fn(),
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });

    el.dispatch("pointerdown", pointer({ pointerId: 1 }));
    await settleEventLoop();
    for (let index = 0; index < MAX_PENDING_VIEWPORT_INPUTS; index += 1) wheel(index + 1);
    el.dispatch("pointerdown", pointer({ pointerId: 2 }));
    el.dispatch("pointerup", pointer({ pointerId: 2, buttons: 0 }));

    request.resolve();
    await attachment.idle();
    expect(receivedInputs().map(({ type }) => type)).toEqual([
      "pointerDown",
      "wheel",
      "pointerCancel",
      "pointerDown",
      "pointerUp",
    ]);
    expect(calls).toBe(5);
    attachment.detach();
  });

  it("retries a force boundary once when Native reports a full queue", async () => {
    vi.useFakeTimers();
    let calls = 0;
    invoke.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject("viewport input queue is full; boundary input was rejected")
        : Promise.resolve();
    });

    try {
      const retry = sendViewportInput({ type: "pointerCancel" }, true);
      await settleMicrotasks();
      expect(calls).toBe(1);
      vi.advanceTimersByTime(VIEWPORT_INPUT_RETRY_DELAY_MS);
      await retry;

      expect(calls).toBe(2);
      expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerCancel", "pointerCancel"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a detached attachment's delayed boundary after a new attachment starts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    invoke.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject("viewport input queue is full; boundary input was rejected")
        : Promise.resolve();
    });

    try {
      const firstElement = new FakeElement();
      const firstAttachment = attachViewportInput(firstElement as unknown as HTMLElement);
      firstElement.dispatch("pointerdown", pointer());
      await settleMicrotasks();
      firstAttachment.detach();

      const secondElement = new FakeElement();
      const secondAttachment = attachViewportInput(secondElement as unknown as HTMLElement);
      secondElement.dispatch("pointerdown", pointer());
      await secondAttachment.idle();
      vi.advanceTimersByTime(VIEWPORT_INPUT_RETRY_DELAY_MS);
      await firstAttachment.idle();

      expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerDown"]);
      expect(calls).toBe(2);
      secondAttachment.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending move before pointerup", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    el.dispatch("pointermove", pointer({ clientX: 80, clientY: 90 }));
    el.dispatch("pointerup", pointer({ clientX: 80, clientY: 90, buttons: 0 }));
    await settleEventLoop();

    expect(receivedInputs().map(({ type }) => type)).toEqual([
      "pointerDown",
      "pointerMove",
      "pointerUp",
    ]);
  });

  it("does not turn Chromium's release-state move into a drag cancel before pointerup", async () => {
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);

    el.dispatch("pointerdown", pointer());
    el.dispatch("pointermove", pointer({ clientX: 70, clientY: 80, buttons: 1 }));
    rafCallbacks.shift()?.(0);
    el.dispatch("pointermove", pointer({ clientX: 72, clientY: 82, buttons: 0 }));
    el.dispatch("pointerup", pointer({ clientX: 72, clientY: 82, buttons: 0 }));
    await attachment.idle();

    expect(receivedInputs().map(({ type }) => type)).toEqual([
      "pointerDown",
      "pointerMove",
      "pointerUp",
    ]);
  });

  it("keeps Undo fenced until the gesture boundary reaches native input", async () => {
    const requests = [deferred<void>(), deferred<void>()];
    let callIndex = 0;
    invoke.mockImplementation(() => requests[callIndex++]?.promise ?? Promise.resolve());
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);

    el.dispatch("pointerdown", pointer());
    el.dispatch("pointerup", pointer({ buttons: 0 }));
    let fenceResolved = false;
    const fence = waitForViewportInputIdle().then(() => {
      fenceResolved = true;
    });
    await settleMicrotasks();
    expect(fenceResolved).toBe(false);

    requests[0]?.resolve();
    await settleMicrotasks();
    expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerUp"]);
    expect(fenceResolved).toBe(false);

    requests[1]?.resolve();
    await fence;
    expect(fenceResolved).toBe(true);
    attachment.detach();
  });

  it("drops a queued move on pointercancel and sends the terminal semantic", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    el.dispatch("pointermove", pointer({ clientX: 80 }));
    el.dispatch("pointercancel", pointer({ buttons: 0 }));
    await settleEventLoop();

    expect(receivedInputs()).toEqual([
      { type: "pointerDown", x: 20, y: 20, button: 0, modifiers: 0 },
      { type: "pointerCancel" },
    ]);
  });

  it("ignores a terminal event from a non-active pointer", async () => {
    const el = new FakeElement();
    attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer({ pointerId: 1 }));
    el.dispatch("pointerdown", pointer({ pointerId: 2 }));
    el.dispatch("pointerup", pointer({ pointerId: 1, buttons: 0 }));
    el.dispatch("pointercancel", pointer({ pointerId: 1, buttons: 0 }));
    el.dispatch("pointermove", pointer({ pointerId: 2, clientX: 90 }));
    el.dispatch("pointerup", pointer({ pointerId: 2, buttons: 0 }));
    await settleEventLoop();

    expect(receivedInputs().map(({ type }) => type)).toEqual([
      "pointerDown",
      "pointerCancel",
      "pointerDown",
      "pointerMove",
      "pointerUp",
    ]);
  });

  it("keeps idle pending until detached input IPC drains", async () => {
    const request = deferred<void>();
    let count = 0;
    invoke.mockImplementation(() => (count++ === 0 ? request.promise : Promise.resolve()));
    const el = new FakeElement();
    const active = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    active.detach();
    const idle = active.idle();
    let settled = false;
    void idle.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    request.resolve();
    await idle;
    expect(settled).toBe(true);
    expect(receivedInputs().map(({ type }) => type)).toEqual([
      "pointerDown",
      "pointerCancel",
    ]);
  });

  it("cancels native input on detach without applying a pending move", async () => {
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    el.dispatch("pointermove", pointer({ clientX: 80 }));
    attachment.detach();
    await settleEventLoop();

    expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerCancel"]);
  });

  it("coalesces ordinary moves to the latest value", async () => {
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    el.dispatch("pointermove", pointer({ clientX: 40 }));
    el.dispatch("pointermove", pointer({ clientX: 90 }));
    rafCallbacks[0]?.(0);
    await settleEventLoop();

    expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerMove"]);
    expect(receivedInputs()[1]?.x).toBe(80);
    attachment.detach();
  });

  it("sends buttonless viewport hover moves after a gesture ends", async () => {
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointermove", pointer({ buttons: 0, clientX: 70, clientY: 80 }));
    rafCallbacks[0]?.(0);
    await settleEventLoop();

    expect(receivedInputs()).toEqual([
      { type: "pointerMove", x: 60, y: 60, buttons: 0, modifiers: 0 },
    ]);
    attachment.detach();
  });

  it("coalesces consecutive buttonless hover moves to the latest value", async () => {
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointermove", pointer({ buttons: 0, clientX: 40 }));
    el.dispatch("pointermove", pointer({ buttons: 0, clientX: 90 }));
    rafCallbacks[0]?.(0);
    await settleEventLoop();

    expect(receivedInputs()).toEqual([
      { type: "pointerMove", x: 80, y: 20, buttons: 0, modifiers: 0 },
    ]);
    attachment.detach();
  });

  it("does not send a pending hover move after detach", async () => {
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointermove", pointer({ buttons: 0, clientX: 90 }));
    attachment.detach();
    await settleEventLoop();

    expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerCancel"]);
  });

  it("replaces an unsent move while the previous IPC request is stalled", async () => {
    const request = deferred<void>();
    let count = 0;
    invoke.mockImplementation(() => (count++ === 0 ? request.promise : Promise.resolve()));
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    await settleMicrotasks();

    el.dispatch("pointermove", pointer({ clientX: 40 }));
    rafCallbacks[0]?.(0);
    el.dispatch("pointermove", pointer({ clientX: 90 }));
    rafCallbacks[1]?.(16);
    request.resolve();
    await attachment.idle();

    expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerMove"]);
    expect(receivedInputs()[1]?.x).toBe(80);
    attachment.detach();
  });

  it("combines unsent wheel deltas while an IPC request is stalled", async () => {
    const request = deferred<void>();
    let count = 0;
    invoke.mockImplementation(() => (count++ === 0 ? request.promise : Promise.resolve()));
    const el = new FakeElement();
    const attachment = attachViewportInput(el as unknown as HTMLElement);
    el.dispatch("pointerdown", pointer());
    await settleMicrotasks();

    const wheel = (dy: number) => ({
      deltaX: 0,
      deltaY: dy,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    el.dispatch("wheel", wheel(-40));
    el.dispatch("wheel", wheel(-60));
    request.resolve();
    await attachment.idle();

    expect(receivedInputs()).toEqual([
      { type: "pointerDown", x: 20, y: 20, button: 0, modifiers: 0 },
      { type: "wheel", dx: 0, dy: -100, modifiers: 0 },
    ]);
    attachment.detach();
  });
});

describe("viewport input self-test lifecycle", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve());
    vi.stubEnv("VITE_MANIPULATOR_SELF_TEST", "translate");
  });

  it("cancels all pending scripted input after cleanup", () => {
    vi.useFakeTimers();
    try {
      const el = new FakeElement();
      const selfTest = maybeRunViewportInputSelfTest(el as unknown as HTMLElement);
      selfTest.cancel();
      vi.advanceTimersByTime(10_000);

      expect(invoke).not.toHaveBeenCalled();

      const restarted = maybeRunViewportInputSelfTest(el as unknown as HTMLElement);
      vi.advanceTimersByTime(2499);
      expect(invoke).not.toHaveBeenCalled();
      restarted.cancel();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("drops not-yet-started nested camera timers on cancel", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_INPUT_SELF_TEST", "1");
    vi.stubEnv("VITE_MANIPULATOR_SELF_TEST", "");
    try {
      const requests = [deferred<void>()];
      invoke.mockImplementation(() => requests[0]?.promise ?? Promise.resolve());
      const selfTest = maybeRunViewportInputSelfTest(new FakeElement() as unknown as HTMLElement);
      vi.advanceTimersByTime(2500);
      await settleMicrotasks();
      expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown"]);

      selfTest.cancel();
      requests[0]?.resolve();
      await selfTest.idle();
      vi.advanceTimersByTime(10_000);
      await settleMicrotasks();

      expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown"]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("cancels nested camera pointer and wheel timers", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_INPUT_SELF_TEST", "1");
    vi.stubEnv("VITE_MANIPULATOR_SELF_TEST", "");
    try {
      const el = new FakeElement();
      const selfTest = maybeRunViewportInputSelfTest(el as unknown as HTMLElement);
      vi.advanceTimersByTime(2500);
      await settleMicrotasks();
      expect(invoke).toHaveBeenCalledTimes(1);

      selfTest.cancel();
      vi.advanceTimersByTime(10_000);

      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("serializes manipulator self-test boundaries and keeps completion one-shot", async () => {
    vi.useFakeTimers();
    const requests = [deferred<void>(), deferred<void>(), deferred<void>()];
    let callIndex = 0;
    invoke.mockImplementation(() => requests[callIndex++].promise);
    try {
      const el = new FakeElement();
      const first = maybeRunViewportInputSelfTest(el as unknown as HTMLElement);
      vi.advanceTimersByTime(2500);
      await settleMicrotasks();
      expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown"]);
      requests[0]?.resolve();
      await settleMicrotasks();
      expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerMove"]);
      requests[1]?.resolve();
      await settleMicrotasks();
      expect(receivedInputs().map(({ type }) => type)).toEqual(["pointerDown", "pointerMove", "pointerUp"]);
      requests[2]?.resolve();
      await first.idle();

      const sent = invoke.mock.calls.length;
      first.cancel();

      const second = maybeRunViewportInputSelfTest(el as unknown as HTMLElement);
      vi.advanceTimersByTime(2500);

      expect(sent).toBe(3);
      expect(invoke).toHaveBeenCalledTimes(sent);
      second.cancel();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

});
