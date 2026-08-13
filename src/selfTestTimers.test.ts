import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelfTestTimerBag } from "./selfTestTimers";

describe("self-test timer bag", () => {
  let previousWindowDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      } as unknown as Window,
    });
  });

  afterEach(() => {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, "window", previousWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    previousWindowDescriptor = undefined;
    vi.useRealTimers();
  });

  it("runs scheduled callbacks and resolves active delays", async () => {
    const timers = createSelfTestTimerBag();
    const callback = vi.fn();
    timers.schedule(callback, 100);
    const delayed = timers.delay(150);

    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    await expect(delayed).resolves.toBe(true);
    expect(timers.isCancelled()).toBe(false);
  });

  it("cancels callbacks and resolves pending delays as incomplete", async () => {
    const timers = createSelfTestTimerBag();
    const callback = vi.fn();
    timers.schedule(callback, 100);
    const delayed = timers.delay(150);

    timers.cancel();
    timers.cancel();
    vi.advanceTimersByTime(150);

    expect(callback).not.toHaveBeenCalled();
    await expect(delayed).resolves.toBe(false);
    expect(timers.isCancelled()).toBe(true);
  });

  it("does not arm work after cancellation", async () => {
    const timers = createSelfTestTimerBag();
    const callback = vi.fn();
    timers.cancel();
    timers.schedule(callback, 0);
    const delayed = timers.delay(0);

    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();
    await expect(delayed).resolves.toBe(false);
  });
});
