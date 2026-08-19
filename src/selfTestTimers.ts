/**
 * Owns dev-only self-test timers and fences delayed work after cleanup.
 *
 * `schedule` is used by one-shot callback steps while `delay` is used by
 * async sequences. Both share the same cancellation boundary so StrictMode,
 * unmount, and HMR cleanup cannot leave work armed.
 */
export interface SelfTestTimerBag {
  readonly isCancelled: () => boolean;
  schedule(callback: () => void, delayMs: number): void;
  delay(delayMs: number): Promise<boolean>;
  cancel(): void;
}

export function createSelfTestTimerBag(): SelfTestTimerBag {
  let cancelled = false;
  const timers = new Set<number>();
  const delayedResolvers = new Map<number, (completed: boolean) => void>();

  const schedule = (callback: () => void, delayMs: number): void => {
    if (cancelled) return;
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!cancelled) callback();
    }, delayMs);
    timers.add(timer);
  };

  const delay = (delayMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (cancelled) {
        resolve(false);
        return;
      }
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        delayedResolvers.delete(timer);
        resolve(!cancelled);
      }, delayMs);
      timers.add(timer);
      delayedResolvers.set(timer, resolve);
    });

  return {
    isCancelled: () => cancelled,
    schedule,
    delay,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      delayedResolvers.forEach((resolve) => resolve(false));
      delayedResolvers.clear();
    },
  };
}
