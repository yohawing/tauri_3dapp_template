import { describe, expect, it } from "vitest";
import { createGltfTimelineDataSource, type GltfTimelineProjection } from "./gltfProjectionDataSource";

const projection: GltfTimelineProjection = {
  revision: 7,
  clips: [
    {
      instanceId: "brainstem",
      clipIndex: 0,
      label: "Animation 1",
      duration: 2,
      channels: [
        {
          id: "c0",
          nodeIndex: 1,
          nodeLabel: "Node 2",
          property: "translation",
          interpolation: "linear",
          keyTimes: [0, 0.01, 0.02, 1, 2],
        },
      ],
    },
  ],
};

describe("glTF Timeline projection adapter", () => {
  it("keeps compact key arrays and groups same-pixel keys", () => {
    const source = createGltfTimelineDataSource(projection);
    const rows = source.getRows({ start: 0, count: 100 });
    const channelRow = rows.find((row) => row.kind === "channel")!;
    const columns = source.getKeyColumns!(
      { rowIds: [channelRow.id], range: { start: 0, end: 2 } },
      10,
    );
    expect(columns.map((column) => [column.time, column.count])).toEqual([
      [0, 3],
      [1, 1],
    ]);
    expect(source.getKeys({ rowIds: [channelRow.id], range: { start: 0, end: 2 } })).toEqual([]);
  });

  it("uses half-open visible ranges and exposes the clip duration", () => {
    const source = createGltfTimelineDataSource(projection);
    const channelRow = source.getRows({ start: 0, count: 100 }).find((row) => row.kind === "channel")!;
    expect(source.getRange()).toEqual({ start: 0, end: 2 });
    expect(
      source.getKeyColumns!({ rowIds: [channelRow.id], range: { start: 1, end: 2 } }, 100),
    ).toHaveLength(1);
  });
});
