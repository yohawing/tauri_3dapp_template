import { invoke } from "@tauri-apps/api/core";
import { fixtureTimelineDataSource } from "./fixtureDataSource";
import {
  timelineId,
  type ChannelId,
  type RowId,
  type TimelineBinding,
  type TimelineDataSource,
  type TimelineGroup,
  type TimelineItem,
  type TimelineKeyColumn,
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
  const channels: ChannelRecord[] = [];
  let duration = 0;

  for (const clip of projection.clips) {
    duration = Math.max(duration, clip.duration);
    const clipGroupId = timelineId<"group">(`clip-group:${clip.instanceId}:${clip.clipIndex}`);
    const clipRowId = timelineId<"row">(`clip-row:${clip.instanceId}:${clip.clipIndex}`);
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
      groups.push({ id: groupId, label: nodeLabel, color: "#55a6d9" });
      bindings.push({ id: bindingId, label: nodeLabel, targetKind: "property" });
      rows.push({
        id: timelineId<"row">(`node-row:${clip.instanceId}:${clip.clipIndex}:${nodeIndex}`),
        label: nodeLabel,
        kind: "group",
        depth: 0,
        groupId,
        bindingId,
        color: "#55a6d9",
        expanded: true,
      });

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
        channels.push({ rowId, channelId, times: Float32Array.from(channel.keyTimes) });
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
    getRows: ({ start, count }) => rows.slice(start, start + count),
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
      const requestedRows = new Set<RowId>(query.rowIds);
      const result: TimelineKeyColumn[] = [];
      for (const channel of channels) {
        if (!requestedRows.has(channel.rowId)) continue;
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
      return result;
    },
  };
}

class RuntimeTimelineDataSource implements TimelineDataSource {
  private current: TimelineDataSource = fixtureTimelineDataSource;
  private revision = 1;
  private readonly listeners = new Set<() => void>();

  constructor() {
    void this.load();
  }

  private async load() {
    try {
      const projection = await invoke<GltfTimelineProjection>("get_timeline_projection");
      if (projection.clips.length === 0) return;
      this.current = createGltfTimelineDataSource(projection);
      this.revision += 1;
      this.listeners.forEach((listener) => listener());
      const clip = projection.clips[0];
      const keys = projection.clips.reduce(
        (sum, current) =>
          sum + current.channels.reduce((channelSum, channel) => channelSum + channel.keyTimes.length, 0),
        0,
      );
      window.dispatchEvent(
        new CustomEvent("tauri3d:diagnostic", {
          detail: {
            level: "info",
            source: "scene",
            message: `${clip.label}: ${projection.clips.length} clip, ${clip.channels.length} channels, ${keys} keys`,
          },
        }),
      );
    } catch (error) {
      console.warn("[Timeline] runtime projection unavailable; keeping fixture", error);
    }
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
  getRows: TimelineDataSource["getRows"] = (query) => this.current.getRows(query);
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

export const runtimeTimelineDataSource: TimelineDataSource = new RuntimeTimelineDataSource();
