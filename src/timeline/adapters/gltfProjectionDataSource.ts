import { invoke } from "@tauri-apps/api/core";
import { safeDiagnosticText } from "../../console/contracts";
import { fixtureTimelineDataSource } from "./fixtureDataSource";
import {
  isBoundedUtf8String,
  isFiniteF32,
  isSafeNonNegativeInteger,
  isWireRecord,
} from "../../wireValidation";
import {
  timelineId,
  type ChannelId,
  type RowId,
  type TimelineBinding,
  type TimelineDataSource,
  type TimelineGroup,
  type TimelineItem,
  type TimelineKeyColumn,
  type TimelinePlaybackTarget,
  type TimelineRow,
} from "../core/contracts";

export type GltfTimelineProperty = "translation" | "rotation" | "scale" | "morphWeights";
export type GltfTimelineInterpolation = "linear" | "step" | "cubicSpline";

export interface GltfTimelineChannelProjection {
  id: string;
  nodeIndex: number;
  nodeLabel: string;
  property: GltfTimelineProperty;
  interpolation: GltfTimelineInterpolation;
  keyTimes: number[];
}

export interface GltfTimelineClipProjection {
  instanceId: string;
  clipIndex: number;
  label: string;
  duration: number;
  channels: GltfTimelineChannelProjection[];
}

export interface GltfTimelineProjection {
  revision: number;
  clips: GltfTimelineClipProjection[];
}

const MAX_TIMELINE_CLIPS = 64;
const MAX_TIMELINE_CHANNELS = 65_536;
const MAX_TIMELINE_KEY_TIMES = 1_000_000;
// The DCC Timeline contract accepts clips up to 24 hours. This keeps the
// ruler/content width below browser element-size limits at the maximum
// 180 px/s zoom; larger Native metadata must not create an unbounded layout.
const MAX_TIMELINE_DURATION_SECONDS = 86_400;
const MAX_TIMELINE_INSTANCE_ID_BYTES = 1024;
const MAX_TIMELINE_ID_BYTES = 4096;
const MAX_TIMELINE_LABEL_BYTES = 4096;

function isTimelineProperty(value: unknown): value is GltfTimelineProperty {
  return value === "translation" || value === "rotation" || value === "scale" || value === "morphWeights";
}

function isTimelineInterpolation(value: unknown): value is GltfTimelineInterpolation {
  return value === "linear" || value === "step" || value === "cubicSpline";
}

/** Reject malformed Native Timeline metadata before it reaches row/key derivation. */
export function normalizeGltfTimelineProjection(value: unknown): GltfTimelineProjection | null {
  if (!isWireRecord(value) || !isSafeNonNegativeInteger(value.revision) || !Array.isArray(value.clips) ||
    value.clips.length > MAX_TIMELINE_CLIPS) return null;

  const clips: GltfTimelineClipProjection[] = [];
  const clipKeys = new Set<string>();
  const channelIds = new Set<string>();
  let channelCount = 0;
  let keyTimeCount = 0;

  for (const rawClip of value.clips) {
    if (!isWireRecord(rawClip) || !isBoundedUtf8String(rawClip.instanceId, MAX_TIMELINE_INSTANCE_ID_BYTES) ||
      !isSafeNonNegativeInteger(rawClip.clipIndex) || !isBoundedUtf8String(rawClip.label, MAX_TIMELINE_LABEL_BYTES) ||
      !isFiniteF32(rawClip.duration) || rawClip.duration < 0 ||
      rawClip.duration > MAX_TIMELINE_DURATION_SECONDS ||
      !Array.isArray(rawClip.channels)) return null;
    const clipKey = `${rawClip.instanceId}:${rawClip.clipIndex}`;
    if (clipKeys.has(clipKey)) return null;
    clipKeys.add(clipKey);
    if (rawClip.channels.length > MAX_TIMELINE_CHANNELS - channelCount) return null;

    const channels: GltfTimelineChannelProjection[] = [];
    const nodeLabels = new Map<number, string>();
    let lastClipKeyTime = 0;
    for (const rawChannel of rawClip.channels) {
      if (!isWireRecord(rawChannel) || !isBoundedUtf8String(rawChannel.id, MAX_TIMELINE_ID_BYTES) || channelIds.has(rawChannel.id) ||
        !isSafeNonNegativeInteger(rawChannel.nodeIndex) || !isBoundedUtf8String(rawChannel.nodeLabel, MAX_TIMELINE_LABEL_BYTES) ||
        !isTimelineProperty(rawChannel.property) || !isTimelineInterpolation(rawChannel.interpolation) ||
        !Array.isArray(rawChannel.keyTimes) || rawChannel.keyTimes.length > MAX_TIMELINE_KEY_TIMES - keyTimeCount) {
        return null;
      }
      const existingLabel = nodeLabels.get(rawChannel.nodeIndex);
      if (existingLabel !== undefined && existingLabel !== rawChannel.nodeLabel) return null;
      nodeLabels.set(rawChannel.nodeIndex, rawChannel.nodeLabel);
      let previousTime = -Infinity;
      const keyTimes: number[] = [];
      for (const rawTime of rawChannel.keyTimes) {
        if (!isFiniteF32(rawTime) || rawTime < 0 || rawTime < previousTime) {
          return null;
        }
        previousTime = rawTime;
        lastClipKeyTime = Math.max(lastClipKeyTime, rawTime);
        keyTimes.push(rawTime);
      }
      if (lastClipKeyTime > rawClip.duration) return null;
      channelIds.add(rawChannel.id);
      channelCount += 1;
      keyTimeCount += keyTimes.length;
      channels.push({
        id: rawChannel.id,
        nodeIndex: rawChannel.nodeIndex,
        nodeLabel: rawChannel.nodeLabel,
        property: rawChannel.property,
        interpolation: rawChannel.interpolation,
        keyTimes,
      });
    }
    clips.push({
      instanceId: rawClip.instanceId,
      clipIndex: rawClip.clipIndex,
      label: rawClip.label,
      duration: rawClip.duration,
      channels,
    });
  }
  return { revision: value.revision, clips };
}

interface ChannelRecord {
  rowId: RowId;
  channelId: ChannelId;
  times: Float32Array;
}

function lowerBound(values: Float32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createGltfTimelineDataSource(
  projection: GltfTimelineProjection,
): TimelineDataSource {
  const groups: TimelineGroup[] = [];
  const bindings: TimelineBinding[] = [];
  const rows: TimelineRow[] = [];
  const items: TimelineItem[] = [];
  const channelsByRow = new Map<RowId, ChannelRecord[]>();
  const playbackTargets = new Map<RowId, TimelinePlaybackTarget>();
  let duration = 0;

  for (const clip of projection.clips) {
    const playbackTarget = { instanceId: clip.instanceId, clipIndex: clip.clipIndex };
    duration = Math.max(duration, clip.duration);
    const clipGroupId = timelineId<"group">(`clip-group:${clip.instanceId}:${clip.clipIndex}`);
    const clipRowId = timelineId<"row">(`clip-row:${clip.instanceId}:${clip.clipIndex}`);
    playbackTargets.set(clipRowId, playbackTarget);
    groups.push({ id: clipGroupId, label: clip.label, color: "#7c8cff" });
    rows.push({
      id: clipRowId,
      label: clip.label,
      kind: "group",
      depth: 0,
      groupId: clipGroupId,
      color: "#7c8cff",
      expanded: true,
    });
    items.push({
      kind: "clip",
      id: timelineId<"clip">(`clip:${clip.instanceId}:${clip.clipIndex}`),
      rowId: clipRowId,
      label: `${clip.label} · ${clip.channels.length} channels`,
      range: { start: 0, end: clip.duration },
      color: "#6677df",
    });

    const channelsByNode = new Map<number, GltfTimelineChannelProjection[]>();
    for (const channel of clip.channels) {
      const list = channelsByNode.get(channel.nodeIndex) ?? [];
      list.push(channel);
      channelsByNode.set(channel.nodeIndex, list);
    }

    for (const [nodeIndex, nodeChannels] of channelsByNode) {
      const nodeLabel = nodeChannels[0].nodeLabel;
      const groupId = timelineId<"group">(`node-group:${clip.instanceId}:${clip.clipIndex}:${nodeIndex}`);
      const bindingId = timelineId<"binding">(`node-binding:${clip.instanceId}:${nodeIndex}`);
      const nodeRowId = timelineId<"row">(`node-row:${clip.instanceId}:${clip.clipIndex}:${nodeIndex}`);
      groups.push({ id: groupId, label: nodeLabel, color: "#55a6d9" });
      bindings.push({ id: bindingId, label: nodeLabel, targetKind: "property" });
      rows.push({
        id: nodeRowId,
        label: nodeLabel,
        kind: "group",
        depth: 0,
        groupId,
        bindingId,
        color: "#55a6d9",
        expanded: true,
      });
      playbackTargets.set(nodeRowId, playbackTarget);

      for (const channel of nodeChannels) {
        const rowId = timelineId<"row">(`channel-row:${channel.id}`);
        const channelId = timelineId<"channel">(`channel:${channel.id}`);
        rows.push({
          id: rowId,
          label: channel.property,
          kind: "channel",
          depth: 1,
          groupId,
          bindingId,
            color:
            channel.property === "translation"
              ? "#62b4ff"
              : channel.property === "rotation"
                ? "#bc8cff"
                : "#62d6a8",
        });
        playbackTargets.set(rowId, playbackTarget);
        const record = { rowId, channelId, times: Float32Array.from(channel.keyTimes) };
        const rowChannels = channelsByRow.get(rowId);
        if (rowChannels) rowChannels.push(record);
        else channelsByRow.set(rowId, [record]);
      }
    }
  }

  return {
    subscribe: () => () => undefined,
    getRevision: () => projection.revision,
    getDomain: () => ({ kind: "seconds" }),
    getRange: () => ({ start: 0, end: Math.max(1, duration) }),
    getGroups: () => groups,
    getBindings: () => bindings,
    getRowCount: () => rows.length,
    getRows: ({ start, count }) => rows.slice(start, start + count),
    getPlaybackTarget: (rowId) => playbackTargets.get(rowId) ?? null,
    getItems: (query) =>
      items.filter(
        (item) =>
          query.rowIds.includes(item.rowId) &&
          item.kind === "clip" &&
          item.range.start < query.range.end &&
          query.range.start < item.range.end,
      ),
    getKeys: () => [],
    getKeyColumns: (query, pixelsPerTimeUnit) => {
      const result: TimelineKeyColumn[] = [];
      for (const rowId of query.rowIds) {
        const rowChannels = channelsByRow.get(rowId);
        if (!rowChannels) continue;
        for (const channel of rowChannels) {
          const start = lowerBound(channel.times, query.range.start);
          const end = lowerBound(channel.times, query.range.end);
          let previousPixel = Number.NaN;
          let column: TimelineKeyColumn | undefined;
          for (let index = start; index < end; index += 1) {
            const time = channel.times[index];
            const pixel = Math.floor((time - query.range.start) * pixelsPerTimeUnit);
            if (pixel !== previousPixel) {
              column = { rowId: channel.rowId, channelId: channel.channelId, time, count: 1 };
              result.push(column);
              previousPixel = pixel;
            } else if (column) {
              column.count += 1;
            }
          }
        }
      }
      return result;
    },
  };
}

export interface TimelineRuntimeDependencies {
  hasTauriRuntime: () => boolean;
  invoke: <T>(command: string) => Promise<T>;
  onSceneFileChanged: (listener: () => void) => () => void;
  reportDiagnostic: (level: "info" | "warn", message: string) => void;
  warn: (error: unknown) => void;
}

class RuntimeTimelineDataSource implements TimelineDataSource {
  private current: TimelineDataSource = createGltfTimelineDataSource({ revision: 0, clips: [] });
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private requestGeneration = 0;
  private disposed = false;
  private loadInFlight: Promise<void> | undefined;
  private queuedAcceptEmpty = false;
  private warned = false;
  private readonly onSceneFileChanged = () => void this.load(true);
  private readonly removeSceneFileChanged: () => void;

  constructor(private readonly dependencies: TimelineRuntimeDependencies) {
    void this.load();
    this.removeSceneFileChanged = this.dependencies.onSceneFileChanged(this.onSceneFileChanged);
  }

  dispose() {
    this.disposed = true;
    this.requestGeneration += 1;
    this.queuedAcceptEmpty = false;
    this.removeSceneFileChanged();
  }

  private load(acceptEmpty = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loadInFlight) {
      this.queuedAcceptEmpty ||= acceptEmpty;
      return this.loadInFlight;
    }
    const generation = ++this.requestGeneration;
    const request = (async () => {
      try {
        const rawProjection = await this.dependencies.invoke<unknown>("get_timeline_projection");
        if (this.disposed || generation !== this.requestGeneration) return;
        const projection = normalizeGltfTimelineProjection(rawProjection);
        if (!projection) {
          if (!this.warned) {
            this.warned = true;
            const error = new Error("malformed timeline projection payload");
            this.dependencies.warn(error);
            this.dependencies.reportDiagnostic(
              "warn",
              `Runtime timeline projection unavailable: ${safeDiagnosticText(error)}`,
            );
          }
          return;
        }
        this.warned = false;
        if (projection.clips.length === 0 && !acceptEmpty) return;
        this.current = createGltfTimelineDataSource(projection);
        this.revision += 1;
        this.listeners.forEach((listener) => {
          try {
            listener();
          } catch (error) {
            try {
              console.error("[Timeline] subscriber failed:", error);
            } catch {
              // Console implementations can be replaced by embedding hosts.
            }
          }
        });
        // A subscriber may synchronously dispose the source while handling
        // the notification (for example during HMR/unmount).  Do not emit
        // the success diagnostic for that stale generation.
        if (this.disposed || generation !== this.requestGeneration) return;
        const clip = projection.clips[0];
        const keys = projection.clips.reduce(
          (sum, current) =>
            sum + current.channels.reduce((channelSum, channel) => channelSum + channel.keyTimes.length, 0),
          0,
        );
        if (clip) {
          this.dependencies.reportDiagnostic(
            "info",
            `${clip.label}: ${projection.clips.length} clip, ${clip.channels.length} channels, ${keys} keys`,
          );
        }
      } catch (error) {
        if (this.disposed || generation !== this.requestGeneration) return;
        if (!this.warned) {
          this.warned = true;
          this.dependencies.warn(error);
          this.dependencies.reportDiagnostic(
            "warn",
            `Runtime timeline projection unavailable: ${safeDiagnosticText(error)}`,
          );
        }
      }
    })();
    this.loadInFlight = request;
    void request.then(
      () => this.finishLoad(request),
      () => this.finishLoad(request),
    );
    return request;
  }

  private finishLoad(request: Promise<void>): void {
    if (this.loadInFlight !== request) return;
    this.loadInFlight = undefined;
    if (this.disposed || !this.queuedAcceptEmpty) {
      this.queuedAcceptEmpty = false;
      return;
    }
    this.queuedAcceptEmpty = false;
    void this.load(true);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getRevision = () => this.revision;
  getDomain = () => this.current.getDomain();
  getRange = () => this.current.getRange();
  getGroups = () => this.current.getGroups();
  getBindings = () => this.current.getBindings();
  getRowCount = () => this.current.getRowCount();
  getRows: TimelineDataSource["getRows"] = (query) => this.current.getRows(query);
  getPlaybackTarget: NonNullable<TimelineDataSource["getPlaybackTarget"]> = (rowId) =>
    this.current.getPlaybackTarget?.(rowId) ?? null;
  getItems: TimelineDataSource["getItems"] = (query) => this.current.getItems(query);
  getKeys: TimelineDataSource["getKeys"] = (query) => this.current.getKeys(query);
  getKeyColumns: NonNullable<TimelineDataSource["getKeyColumns"]> = (query, pixelsPerTimeUnit) =>
    this.current.getKeyColumns?.(query, pixelsPerTimeUnit) ??
    this.current.getKeys(query).map((key) => ({
      rowId: key.rowId,
      channelId: key.channelId,
      time: key.time,
      count: 1,
    }));
}

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const defaultTimelineDependencies: TimelineRuntimeDependencies = {
  hasTauriRuntime,
  invoke: <T>(command: string) => invoke<T>(command),
  onSceneFileChanged: (listener) => {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("tauri3d:scene-file-changed", listener);
    return () => window.removeEventListener("tauri3d:scene-file-changed", listener);
  },
  reportDiagnostic: (level, message) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("tauri3d:diagnostic", {
        detail: { level, source: "timeline", message },
      }),
    );
  },
  warn: (error) => console.warn("[Timeline] runtime projection unavailable; keeping current data", error),
};

export function createRuntimeTimelineDataSource(
  dependencies: TimelineRuntimeDependencies = defaultTimelineDependencies,
): TimelineDataSource & { dispose(): void } {
  return new RuntimeTimelineDataSource(dependencies);
}

export function createTimelineDataSource(
  dependencies: Partial<TimelineRuntimeDependencies> = {},
): TimelineDataSource {
  const resolved = { ...defaultTimelineDependencies, ...dependencies };
  if (!resolved.hasTauriRuntime()) return fixtureTimelineDataSource;
  return createRuntimeTimelineDataSource(resolved);
}

export const runtimeTimelineDataSource: TimelineDataSource = createTimelineDataSource();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if ("dispose" in runtimeTimelineDataSource) {
      (runtimeTimelineDataSource as RuntimeTimelineDataSource).dispose();
    }
  });
}
