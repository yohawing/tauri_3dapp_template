import { describe, expect, it } from "vitest";
import type { SceneCommandEnvelope, SceneProjection } from "../core/projection";
import {
  applyOptimisticToProjection,
  reconcileSceneProjection,
  shouldAcceptSceneProjection,
} from "./sceneProjectionDataSource";

function projection(): SceneProjection {
  return {
    revision: 4,
    selectedNodeId: "cube",
    nodes: [{ id: "cube", parent: null, label: "Cube", kind: "mesh", visible: true }],
    selected: {
      id: "cube",
      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      material: { color: [1, 0, 0, 1], metallic: 0, roughness: 0.5 },
    },
    lastProcessedSequence: 0,
    commandResults: [],
  };
}

describe("scene projection synchronization", () => {
  it("accepts the first native snapshot but rejects later revision rollback", () => {
    expect(shouldAcceptSceneProjection(false, 10, 0)).toBe(true);
    expect(shouldAcceptSceneProjection(true, 10, 9)).toBe(false);
    expect(shouldAcceptSceneProjection(true, 10, 10)).toBe(false);
    expect(shouldAcceptSceneProjection(true, 10, 11)).toBe(true);
  });

  it("keeps optimistic values until ack and rolls back rejected commands", () => {
    const command: SceneCommandEnvelope = {
      sequence: 7,
      command: { type: "setMetallic", nodeId: "cube", value: 0.9 },
    };
    const optimistic = applyOptimisticToProjection(projection(), command);
    expect(optimistic.selected?.material?.metallic).toBe(0.9);

    const rejected = projection();
    rejected.commandResults = [
      {
        sequence: 7,
        nodeId: "cube",
        property: "metallic",
        applied: false,
        error: "unsupported scene node",
      },
    ];
    const reconciled = reconcileSceneProjection(
      rejected,
      new Map([["cube/metallic", command]]),
    );
    expect(reconciled.pending.size).toBe(0);
    expect(reconciled.projection.selected?.material?.metallic).toBe(0);
  });

  it("retains a newer optimistic value when an older result arrives", () => {
    const older: SceneCommandEnvelope = {
      sequence: 7,
      command: { type: "setRoughness", nodeId: "cube", value: 0.1 },
    };
    const newer: SceneCommandEnvelope = {
      sequence: 8,
      command: { type: "setRoughness", nodeId: "cube", value: 0.8 },
    };
    const next = projection();
    next.commandResults = [
      { sequence: 7, nodeId: "cube", property: "roughness", applied: true, error: null },
    ];
    const reconciled = reconcileSceneProjection(next, new Map([["cube/roughness", newer]]));
    expect(reconciled.pending.size).toBe(1);
    expect(reconciled.projection.selected?.material?.roughness).toBe(0.8);
    expect(older.sequence).toBeLessThan(newer.sequence);
  });

  it("optimistically toggles canonical node visibility and rolls back on reject", () => {
    const command: SceneCommandEnvelope = {
      sequence: 11,
      command: { type: "setVisibility", nodeId: "cube", visible: false },
    };
    const optimistic = applyOptimisticToProjection(projection(), command);
    expect(optimistic.nodes.find((node) => node.id === "cube")?.visible).toBe(false);

    const rejected = projection();
    rejected.commandResults = [
      {
        sequence: 11,
        nodeId: "cube",
        property: "visibility",
        applied: false,
        error: "unsupported scene node",
      },
    ];
    const reconciled = reconcileSceneProjection(
      rejected,
      new Map([["cube/visibility", command]]),
    );
    expect(reconciled.pending.size).toBe(0);
    expect(reconciled.projection.nodes.find((node) => node.id === "cube")?.visible).toBe(true);
  });
});
