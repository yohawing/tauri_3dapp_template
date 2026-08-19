import { describe, expect, it, vi } from "vitest";
import {
  createTimelinePlaybackDispatcher,
  createTimelinePlaybackCommandEnvelope,
  createTimelinePlaybackCommandFlight,
  createTimelinePlaybackListener,
  timelinePlaybackCommandResultMatchesFlight,
  projectTimelinePlaybackTime,
  resolveTimelinePlaybackTarget,
  shouldRollbackTimelinePlaybackCommand,
  timelinePlaybackTargetEquals,
  timelineEventAges,
  timelineSequenceGap,
  normalizeTimelinePlaybackSnapshot,
  reportTimelineEventPerformance,
  type TimelinePlaybackCommand,
  type TimelinePlaybackCommandResult,
  type TimelinePlaybackSnapshot,
  type TimelineEventPerformanceSummary,
} from "./playback";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const snapshot = (overrides: Partial<TimelinePlaybackSnapshot> = {}): TimelinePlaybackSnapshot => ({
  epoch: 1,
  revision: 1,
  sampledAtUnixMs: 10_000,
  emittedAtUnixMs: 10_012,
  eventSequence: 1,
  available: true,
  instanceId: "model",
  clipIndex: 0,
  time: 1,
  duration: 3,
  playing: true,
  looping: true,
  commandResults: [],
  ...overrides,
});

describe("projectTimelinePlaybackTime", () => {
  it("projects a playing snapshot without mutating the Native source time", () => {
    expect(projectTimelinePlaybackTime(snapshot(), 10_500)).toBe(1.5);
    expect(projectTimelinePlaybackTime(snapshot({ playing: false }), 10_500)).toBe(1);
  });

  it("wraps looping playback and clamps non-looping playback", () => {
    expect(projectTimelinePlaybackTime(snapshot({ time: 2.8 }), 10_500)).toBeCloseTo(0.3);
    expect(projectTimelinePlaybackTime(snapshot({ time: 2.8, looping: false }), 10_500)).toBe(3);
  });

  it("ignores a future timestamp instead of projecting backwards", () => {
    expect(projectTimelinePlaybackTime(snapshot(), 9_500)).toBe(1);
  });
});

describe("timeline playback wire contract", () => {
  it("accepts an available Native snapshot", () => {
    expect(normalizeTimelinePlaybackSnapshot(snapshot())).toEqual(snapshot());
  });

  it.each([
    null,
    { ...snapshot(), epoch: 0 },
    { ...snapshot(), revision: Number.NaN },
    { ...snapshot(), sampledAtUnixMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot(), eventSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot(), time: Number.POSITIVE_INFINITY },
    { ...snapshot(), time: Number.MAX_VALUE },
    { ...snapshot(), duration: Number.MAX_VALUE },
    { ...snapshot(), time: 4 },
    { ...snapshot(), instanceId: null },
    { ...snapshot({ available: false }), instanceId: "stale-target" },
  ])("rejects malformed Native snapshot %#", (payload) => {
    expect(normalizeTimelinePlaybackSnapshot(payload)).toBeNull();
  });

  it("accepts the unavailable replacement boundary shape", () => {
    expect(normalizeTimelinePlaybackSnapshot({
      epoch: 2,
      revision: 0,
      sampledAtUnixMs: 0,
      emittedAtUnixMs: 0,
      eventSequence: 0,
      available: false,
      instanceId: null,
      clipIndex: null,
      time: 0,
      duration: 0,
      playing: false,
      looping: false,
      commandResults: [],
    })).toMatchObject({ epoch: 2, available: false, instanceId: null, clipIndex: null });
  });

  it("validates bounded, ordered command results within the snapshot epoch", () => {
    const result: TimelinePlaybackCommandResult = {
      sequence: 1,
      requestId: 17,
      epoch: 1,
      instanceId: "model",
      clipIndex: 0,
      commandType: "pause",
      applied: false,
      error: "rejected",
    };
    expect(normalizeTimelinePlaybackSnapshot(snapshot({ commandResults: [result] }))?.commandResults).toEqual([result]);
    expect(normalizeTimelinePlaybackSnapshot(snapshot({ commandResults: [{ ...result, epoch: 2 }] }))).toBeNull();
    expect(normalizeTimelinePlaybackSnapshot(snapshot({ commandResults: [{ ...result, sequence: 0 }] }))).toBeNull();
    expect(normalizeTimelinePlaybackSnapshot(snapshot({ commandResults: [{ ...result, requestId: 0 }] }))).toBeNull();
    expect(normalizeTimelinePlaybackSnapshot(snapshot({ commandResults: [result, result] }))).toBeNull();
    expect(normalizeTimelinePlaybackSnapshot(snapshot({
      commandResults: [{ ...result, instanceId: "i".repeat(1_025) }],
    }))).toBeNull();
  });
});

describe("timeline event instrumentation", () => {
  it("turns synchronous report failures into a rejected Promise", async () => {
    const summary = {
      source: "timeline-event",
      sampleCount: 1,
      targetIntervalMs: 100,
      elapsedMs: 1,
      averageDeliveryAgeMs: 1,
      p95DeliveryAgeMs: 1,
      maxDeliveryAgeMs: 1,
      averageSampleToEmitAgeMs: 1,
      p95SampleToEmitAgeMs: 1,
      maxSampleToEmitAgeMs: 1,
      averageEmitToListenerAgeMs: 1,
      p95EmitToListenerAgeMs: 1,
      maxEmitToListenerAgeMs: 1,
      eventSequenceGaps: 0,
      revisionGaps: 0,
      averageEventIntervalMs: 1,
      maxEventIntervalMs: 1,
    } satisfies TimelineEventPerformanceSummary;
    await expect(
      reportTimelineEventPerformance(summary, () => {
        throw new Error("report unavailable");
      }),
    ).rejects.toThrow("report unavailable");
  });

  it("rejects non-finite metrics and strips unknown payload fields", async () => {
    const summary = {
      source: "timeline-event",
      sampleCount: 1,
      targetIntervalMs: 100,
      elapsedMs: 1,
      averageDeliveryAgeMs: 1,
      p95DeliveryAgeMs: 1,
      maxDeliveryAgeMs: 1,
      averageSampleToEmitAgeMs: 1,
      p95SampleToEmitAgeMs: 1,
      maxSampleToEmitAgeMs: 1,
      averageEmitToListenerAgeMs: 1,
      p95EmitToListenerAgeMs: 1,
      maxEmitToListenerAgeMs: 1,
      eventSequenceGaps: 0,
      revisionGaps: 0,
      averageEventIntervalMs: 1,
      maxEventIntervalMs: 1,
    } satisfies TimelineEventPerformanceSummary;
    const report = vi.fn(() => undefined);

    await expect(
      reportTimelineEventPerformance({ ...summary, maxEventIntervalMs: Number.POSITIVE_INFINITY }, report),
    ).rejects.toThrow("Invalid timeline performance summary");
    expect(report).not.toHaveBeenCalled();

    const oversized = { ...summary, unknown: "x".repeat(100_000) } as TimelineEventPerformanceSummary & {
      unknown: string;
    };
    await reportTimelineEventPerformance(oversized, report);
    expect(report).toHaveBeenCalledWith(summary);
  });

  it("splits canonical sample-to-emit and emit-to-listener age", () => {
    expect(timelineEventAges(snapshot(), 10_030)).toEqual({
      sampleToEmitAgeMs: 12,
      emitToListenerAgeMs: 18,
      totalDeliveryAgeMs: 30,
    });
    expect(timelineEventAges(snapshot({ emittedAtUnixMs: 9_900 }), 10_000)).toEqual({
      sampleToEmitAgeMs: 0,
      emitToListenerAgeMs: 100,
      totalDeliveryAgeMs: 100,
    });
  });

  it("counts missing and out-of-order sequence values", () => {
    expect(timelineSequenceGap(undefined, 1)).toBe(0);
    expect(timelineSequenceGap(1, 2)).toBe(0);
    expect(timelineSequenceGap(1, 4)).toBe(2);
    expect(timelineSequenceGap(4, 2)).toBe(1);
  });

  it("captures the current Scene epoch in playback command envelopes", () => {
    const command = { type: "seek", instanceId: "model", clipIndex: 0, time: 1.25 } as const;
    expect(createTimelinePlaybackCommandEnvelope(command, 7, 42)).toEqual({
      epoch: 7,
      requestId: 42,
      command,
    });
  });
});

describe("timeline playback command rollback fencing", () => {
  it("rolls back only the current flight before a newer dispatch or accepted event", () => {
    const accepted = snapshot();
    const command = { type: "play", instanceId: "model", clipIndex: 0 } as const;
    const flight = createTimelinePlaybackCommandFlight(1, 4, command, accepted.epoch, accepted, 17);

    expect(shouldRollbackTimelinePlaybackCommand(flight, flight, 4, accepted)).toBe(true);
    expect(
      shouldRollbackTimelinePlaybackCommand(
        flight,
        createTimelinePlaybackCommandFlight(
          1,
          4,
          { type: "play", instanceId: "other-model", clipIndex: 2 },
          accepted.epoch,
          accepted,
        ),
        4,
        accepted,
      ),
    ).toBe(true);
    expect(
      shouldRollbackTimelinePlaybackCommand(
        flight,
        createTimelinePlaybackCommandFlight(2, 4, command, accepted.epoch, accepted),
        4,
        accepted,
      ),
    ).toBe(false);
    expect(shouldRollbackTimelinePlaybackCommand(flight, flight, 5, accepted)).toBe(false);
    expect(
      shouldRollbackTimelinePlaybackCommand(
        flight,
        flight,
        4,
        snapshot({ revision: accepted.revision + 1, playing: false }),
      ),
    ).toBe(false);
  });

  it("matches command results only to the current flight identity and generation", () => {
    const accepted = snapshot();
    const command = { type: "pause", instanceId: "model", clipIndex: 0 } as const;
    const flight = createTimelinePlaybackCommandFlight(1, 4, command, accepted.epoch, accepted, 17);
    const result = {
      sequence: 1,
      requestId: 17,
      epoch: 1,
      instanceId: "model",
      clipIndex: 0,
      commandType: "pause",
      applied: false,
      error: "rejected",
    } satisfies TimelinePlaybackCommandResult;

    expect(timelinePlaybackCommandResultMatchesFlight(result, flight, 4)).toBe(true);
    expect(timelinePlaybackCommandResultMatchesFlight({ ...result, commandType: "play" }, flight, 4)).toBe(false);
    expect(timelinePlaybackCommandResultMatchesFlight(result, flight, 5)).toBe(false);
  });

  it("forwards the strict request ID through the serialized dispatcher envelope", async () => {
    const requestIds: number[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (_command, _epoch, requestId) => {
      requestIds.push(requestId ?? 0);
    });

    await dispatcher.dispatch({ type: "pause", instanceId: "model", clipIndex: 0 }, 1, 42);
    expect(requestIds).toEqual([42]);
    dispatcher.dispose();
  });
});

describe("timeline playback target selection", () => {
  it("prefers an explicit row selection and falls back to the Native snapshot", () => {
    const snapshotTarget = snapshot({ instanceId: "snapshot-model", clipIndex: 1 });
    const selectedTarget = { instanceId: "selected-model", clipIndex: 3 };

    expect(resolveTimelinePlaybackTarget(selectedTarget, snapshotTarget)).toEqual(selectedTarget);
    expect(resolveTimelinePlaybackTarget(null, snapshotTarget)).toEqual({
      instanceId: "snapshot-model",
      clipIndex: 1,
    });
    expect(resolveTimelinePlaybackTarget(null, snapshot({ available: false }))).toBeNull();
    expect(timelinePlaybackTargetEquals(selectedTarget, { ...selectedTarget })).toBe(true);
    expect(
      timelinePlaybackTargetEquals(selectedTarget, {
        instanceId: snapshotTarget.instanceId!,
        clipIndex: snapshotTarget.clipIndex!,
      }),
    ).toBe(false);
  });
});

describe("timeline playback dispatch ordering", () => {
  it("coalesces queued same-target seeks to the latest value", async () => {
    const first = deferred<void>();
    const calls: TimelinePlaybackCommand[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (command) => {
      calls.push(command);
      if (calls.length === 1) await first.promise;
    });

    const a = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 1 }, 4);
    await settle();
    const b = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 2 }, 4);
    const c = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 3 }, 4);
    first.resolve();
    await Promise.all([a, b, c]);
    expect(calls).toEqual([
      { type: "seek", instanceId: "model", clipIndex: 0, time: 1 },
      { type: "seek", instanceId: "model", clipIndex: 0, time: 3 },
    ]);
  });

  it("settles superseded seek callers before the latest seek is acknowledged", async () => {
    const first = deferred<void>();
    const calls: TimelinePlaybackCommand[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (command) => {
      calls.push(command);
      if (calls.length === 1) await first.promise;
    });

    const active = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 1 }, 4);
    await settle();
    let superseded = false;
    const old = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 2 }, 4).then(() => {
      superseded = true;
    });
    const latest = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 3 }, 4);
    await Promise.resolve();

    expect(superseded).toBe(true);
    expect(calls).toHaveLength(1);
    first.resolve();
    await expect(Promise.all([active, old, latest])).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("preserves seek then pause order across a transport boundary", async () => {
    const first = deferred<void>();
    const calls: TimelinePlaybackCommand[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (command) => {
      calls.push(command);
      if (calls.length === 1) await first.promise;
    });
    const seek = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 1 }, 4);
    await settle();
    const pause = dispatcher.dispatch({ type: "pause", instanceId: "model", clipIndex: 0 }, 4);
    const seekAfterPause = dispatcher.dispatch(
      { type: "seek", instanceId: "model", clipIndex: 0, time: 2 },
      4,
    );
    first.resolve();
    await Promise.all([seek, pause, seekAfterPause]);
    expect(calls.map((command) => command.type)).toEqual(["seek", "pause", "seek"]);
  });

  it("drops queued commands from an older epoch", async () => {
    const first = deferred<void>();
    const calls: TimelinePlaybackCommand[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (command) => {
      calls.push(command);
      if (calls.length === 1) await first.promise;
    });
    const active = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 1 }, 1);
    await settle();
    const stale = dispatcher.dispatch({ type: "pause", instanceId: "model", clipIndex: 0 }, 1);
    const current = dispatcher.dispatch({ type: "play", instanceId: "model", clipIndex: 0 }, 2);
    first.resolve();
    await Promise.all([active, stale, current]);
    expect(calls.map((command) => command.type)).toEqual(["seek", "play"]);
  });

  it("starts a newer epoch after an older transport stalls", async () => {
    const first = deferred<void>();
    const calls: number[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (_command, epoch) => {
      calls.push(epoch);
      if (calls.length === 1) await first.promise;
    });

    const stale = dispatcher.dispatch(
      { type: "seek", instanceId: "model", clipIndex: 0, time: 1 },
      1,
    );
    await settle();
    const current = dispatcher.dispatch(
      { type: "play", instanceId: "model", clipIndex: 0 },
      2,
    );
    await expect(Promise.all([stale, current])).resolves.toEqual([undefined, undefined]);
    expect(calls).toEqual([1, 2]);

    first.resolve();
    await settle();
  });

  it("ignores queued and late work after dispose", async () => {
    const first = deferred<void>();
    const calls: TimelinePlaybackCommand[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (command) => {
      calls.push(command);
      await first.promise;
    });
    const active = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 1 }, 1);
    await settle();
    const queued = dispatcher.dispatch({ type: "pause", instanceId: "model", clipIndex: 0 }, 1);
    dispatcher.dispose();
    await expect(Promise.all([active, queued])).resolves.toEqual([undefined, undefined]);
    first.resolve();
    await settle();
    expect(calls.map((command) => command.type)).toEqual(["seek"]);
  });

  it("rejects new commands when the stalled queue reaches the Rust limit", async () => {
    const first = deferred<void>();
    const calls: TimelinePlaybackCommand[] = [];
    const dispatcher = createTimelinePlaybackDispatcher(async (command) => {
      calls.push(command);
      if (calls.length === 1) await first.promise;
    });

    const active = dispatcher.dispatch({ type: "seek", instanceId: "model", clipIndex: 0, time: 1 }, 1);
    await settle();
    const queued = Array.from({ length: 256 }, (_, index) =>
      dispatcher.dispatch(
        index % 2 === 0
          ? { type: "play", instanceId: "model", clipIndex: 0 }
          : { type: "pause", instanceId: "model", clipIndex: 0 },
        1,
      ),
    );
    const overflow = dispatcher.dispatch({ type: "play", instanceId: "model", clipIndex: 0 }, 1);
    await expect(overflow).rejects.toThrow("timeline playback queue is full");

    first.resolve();
    await expect(Promise.all([active, ...queued])).resolves.toEqual(new Array(257).fill(undefined));
    expect(calls).toHaveLength(257);
  });
});

describe("timeline playback listener lifecycle", () => {
  it("reports an active listener install rejection", async () => {
    const errors: unknown[] = [];
    const lifecycle = createTimelinePlaybackListener(
      async () => {
        throw new Error("listen failed");
      },
      () => undefined,
      (error) => errors.push(error),
    );
    await lifecycle.ready;
    expect(errors).toHaveLength(1);
  });

  it("suppresses an install rejection after dispose", async () => {
    const pending = deferred<(() => void)>();
    const errors: unknown[] = [];
    const lifecycle = createTimelinePlaybackListener(
      () => pending.promise,
      () => undefined,
      (error) => errors.push(error),
    );
    lifecycle.dispose();
    pending.reject(new Error("late listen failed"));
    await lifecycle.ready;
    expect(errors).toEqual([]);
  });

  it("unlistens when install resolves after dispose", async () => {
    const pending = deferred<() => void>();
    const stop = vi.fn();
    const lifecycle = createTimelinePlaybackListener(
      () => pending.promise,
      () => undefined,
      () => undefined,
    );
    lifecycle.dispose();
    pending.resolve(stop);
    await lifecycle.ready;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("drops an event already queued when disposed", async () => {
    let emit: ((value: TimelinePlaybackSnapshot) => void) | undefined;
    const listener = vi.fn();
    const lifecycle = createTimelinePlaybackListener(
      async (callback) => {
        emit = callback;
        return () => undefined;
      },
      listener,
      () => undefined,
    );
    await lifecycle.ready;
    lifecycle.dispose();
    emit?.(snapshot());
    expect(listener).not.toHaveBeenCalled();
  });

  it("absorbs synchronous cleanup throws", async () => {
    const stop = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const lifecycle = createTimelinePlaybackListener(
      async () => stop,
      () => undefined,
      () => undefined,
    );
    await lifecycle.ready;
    expect(() => lifecycle.dispose()).not.toThrow();
  });
});
