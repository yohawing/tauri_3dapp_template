import {
  timelineId,
  type TimelineBinding,
  type TimelineChannel,
  type TimelineDataSource,
  type TimelineGroup,
  type TimelineItem,
  type TimelineKey,
  type TimelineRow,
  type VisibleTimeQuery,
} from "../core/contracts";

const characterGroup = timelineId<"group">("group-character");
const audioGroup = timelineId<"group">("group-audio");
const mikuBinding = timelineId<"binding">("binding-miku");
const cameraBinding = timelineId<"binding">("binding-camera");
const masterAudioBinding = timelineId<"binding">("binding-master-audio");

const rootRow = timelineId<"row">("row-root-motion");
const bodyRow = timelineId<"row">("row-body-motion");
const faceRow = timelineId<"row">("row-face");
const cameraRow = timelineId<"row">("row-camera");
const eventsRow = timelineId<"row">("row-events");
const audioRow = timelineId<"row">("row-audio");

const groups: TimelineGroup[] = [
  { id: characterGroup, label: "Character", color: "#7c8cff" },
  { id: audioGroup, label: "Audio", color: "#55c7a5" },
];

const bindings: TimelineBinding[] = [
  { id: mikuBinding, label: "Miku", targetKind: "actor" },
  { id: cameraBinding, label: "Shot Camera", targetKind: "actor" },
  { id: masterAudioBinding, label: "Master", targetKind: "audio-output" },
];

const rows: TimelineRow[] = [
  {
    id: timelineId<"row">("row-character-group"),
    label: "CHARACTER",
    kind: "group",
    depth: 0,
    groupId: characterGroup,
    color: "#7c8cff",
    expanded: true,
  },
  {
    id: rootRow,
    label: "Root Motion",
    kind: "track",
    depth: 1,
    groupId: characterGroup,
    bindingId: mikuBinding,
    color: "#7c8cff",
  },
  {
    id: bodyRow,
    label: "Body Motion",
    kind: "track",
    depth: 1,
    groupId: characterGroup,
    bindingId: mikuBinding,
    color: "#9b8cff",
  },
  {
    id: eventsRow,
    label: "Events & Markers",
    kind: "track",
    depth: 0,
    color: "#ffb454",
  },
  {
    id: faceRow,
    label: "Face",
    kind: "track",
    depth: 1,
    groupId: characterGroup,
    bindingId: mikuBinding,
    color: "#d47cff",
    muted: true,
  },
  {
    id: cameraRow,
    label: "Camera",
    kind: "track",
    depth: 0,
    bindingId: cameraBinding,
    color: "#57a6ff",
    locked: true,
  },
  {
    id: timelineId<"row">("row-audio-group"),
    label: "AUDIO",
    kind: "group",
    depth: 0,
    groupId: audioGroup,
    color: "#55c7a5",
    expanded: true,
  },
  {
    id: audioRow,
    label: "Music",
    kind: "track",
    depth: 1,
    groupId: audioGroup,
    bindingId: masterAudioBinding,
    color: "#55c7a5",
  },
];

const items: TimelineItem[] = [
  {
    kind: "clip",
    id: timelineId<"clip">("clip-root-intro"),
    rowId: rootRow,
    label: "Walk In",
    range: { start: 0.45, end: 4.2 },
    color: "#6677df",
  },
  {
    kind: "clip",
    id: timelineId<"clip">("clip-root-turn"),
    rowId: rootRow,
    label: "Turn",
    range: { start: 4.55, end: 7.1 },
    color: "#7b6ee6",
    selected: true,
  },
  {
    kind: "clip",
    id: timelineId<"clip">("clip-body-main"),
    rowId: bodyRow,
    label: "Performance_A",
    range: { start: 0.8, end: 8.8 },
    color: "#8b69d2",
  },
  {
    kind: "clip",
    id: timelineId<"clip">("clip-face"),
    rowId: faceRow,
    label: "Lip Sync",
    range: { start: 1.15, end: 9.35 },
    color: "#b964c5",
  },
  {
    kind: "clip",
    id: timelineId<"clip">("clip-camera"),
    rowId: cameraRow,
    label: "Medium → Close Up",
    range: { start: 0, end: 11.1 },
    color: "#397ebc",
  },
  {
    kind: "marker",
    id: timelineId<"marker">("marker-beat"),
    rowId: eventsRow,
    label: "Beat",
    time: 2.5,
    color: "#ffd166",
  },
  {
    kind: "event-cue",
    id: timelineId<"cue">("event-light"),
    rowId: eventsRow,
    label: "Light Hit",
    eventType: "lighting.trigger",
    time: 5.25,
    color: "#ff7a69",
  },
  {
    kind: "cue",
    id: timelineId<"cue">("cue-note"),
    rowId: eventsRow,
    label: "Review",
    time: 8.15,
    color: "#70d6ff",
  },
  {
    kind: "clip",
    id: timelineId<"clip">("clip-audio"),
    rowId: audioRow,
    label: "song_master.wav",
    range: { start: 0.2, end: 11.7 },
    color: "#3f9f88",
  },
];

const channels: TimelineChannel[] = [
  { id: timelineId<"channel">("channel-root"), rowId: rootRow, label: "Root", valueType: "vector3" },
  { id: timelineId<"channel">("channel-body"), rowId: bodyRow, label: "Body", valueType: "quaternion" },
  { id: timelineId<"channel">("channel-face"), rowId: faceRow, label: "Face", valueType: "number" },
];

const keys: TimelineKey[] = [
  ...[0.45, 1.25, 2.1, 3.15, 4.2, 4.55, 5.4, 6.2, 7.1].map((time, index) => ({
    kind: "key" as const,
    id: timelineId<"key">(`key-root-${index}`),
    rowId: rootRow,
    channelId: channels[0].id,
    time,
    selected: time === 4.55,
  })),
  ...[0.8, 1.7, 2.8, 4.1, 5.5, 7.2, 8.8].map((time, index) => ({
    kind: "key" as const,
    id: timelineId<"key">(`key-body-${index}`),
    rowId: bodyRow,
    channelId: channels[1].id,
    time,
  })),
  ...[1.15, 2.35, 3.6, 5.8, 7.4, 9.35].map((time, index) => ({
    kind: "key" as const,
    id: timelineId<"key">(`key-face-${index}`),
    rowId: faceRow,
    channelId: channels[2].id,
    time,
  })),
];

function isVisible(query: VisibleTimeQuery, rowId: TimelineRow["id"], time: number): boolean {
  return query.rowIds.includes(rowId) && time >= query.range.start && time < query.range.end;
}

export const fixtureTimelineDataSource: TimelineDataSource = {
  subscribe: () => () => undefined,
  getRevision: () => 1,
  getDomain: () => ({ kind: "seconds" }),
  getRange: () => ({ start: 0, end: 12 }),
  getGroups: () => groups,
  getBindings: () => bindings,
  getRowCount: () => rows.length,
  getRows: ({ start, count }) => rows.slice(start, start + count),
  getItems: (query) =>
    items.filter((item) => {
      if (item.kind === "clip") {
        return (
          query.rowIds.includes(item.rowId) &&
          item.range.start < query.range.end &&
          query.range.start < item.range.end
        );
      }
      return isVisible(query, item.rowId, item.time);
    }),
  getKeys: (query) => keys.filter((key) => isVisible(query, key.rowId, key.time)),
};
