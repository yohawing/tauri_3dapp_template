import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  createThreeSceneGraphController,
  defaultThreeNodeKind,
  snapshotThreeScene,
  threeObjectTransform,
} from "./threeSceneAdapter";

function buildSampleScene() {
  const root = new THREE.Group();
  root.name = "Root";

  const bone = new THREE.Bone();
  bone.name = "mixamorig:Hips";
  root.add(bone);

  const childBone = new THREE.Bone();
  childBone.name = "mixamorig:Spine";
  bone.add(childBone);

  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = "Body";
  root.add(mesh);

  const light = new THREE.DirectionalLight();
  light.name = "Key Light";
  root.add(light);

  return { root, bone, childBone, mesh, light };
}

describe("defaultThreeNodeKind", () => {
  it("classifies bones, meshes, lights, and plain objects", () => {
    const { bone, mesh, light, root } = buildSampleScene();
    expect(defaultThreeNodeKind(bone)).toBe("bone");
    expect(defaultThreeNodeKind(mesh)).toBe("mesh");
    expect(defaultThreeNodeKind(light)).toBe("light");
    expect(defaultThreeNodeKind(root)).toBe("scene");
  });
});

describe("snapshotThreeScene", () => {
  it("walks the whole tree into a flat SceneNodeSummary[] with a registry keyed by uuid", () => {
    const { root, bone, childBone, mesh, light } = buildSampleScene();
    const { nodes, registry } = snapshotThreeScene(root);

    expect(nodes).toHaveLength(5); // root, bone, childBone, mesh, light
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const rootRow = byId.get(root.uuid);
    expect(rootRow).toMatchObject({ parent: null, label: "Root", kind: "scene", visible: true });

    const boneRow = byId.get(bone.uuid);
    expect(boneRow).toMatchObject({ parent: root.uuid, label: "mixamorig:Hips", kind: "bone" });

    const childBoneRow = byId.get(childBone.uuid);
    expect(childBoneRow).toMatchObject({ parent: bone.uuid, label: "mixamorig:Spine", kind: "bone" });

    const meshRow = byId.get(mesh.uuid);
    expect(meshRow).toMatchObject({ parent: root.uuid, label: "Body", kind: "mesh" });

    const lightRow = byId.get(light.uuid);
    expect(lightRow).toMatchObject({ parent: root.uuid, label: "Key Light", kind: "light" });

    expect(registry.get(bone.uuid)).toBe(bone);
    expect(registry.get(mesh.uuid)).toBe(mesh);
  });

  it("labels unnamed objects with their three.js type", () => {
    const group = new THREE.Group();
    const { nodes } = snapshotThreeScene(group);
    expect(nodes[0].label).toBe("Group");
  });

  it("excludes a subtree when include() returns false for its root", () => {
    const { root, bone, mesh } = buildSampleScene();
    const helpers = new THREE.Group();
    helpers.name = "Helpers";
    const grid = new THREE.GridHelper();
    helpers.add(grid);
    root.add(helpers);

    const { nodes } = snapshotThreeScene(root, { include: (object) => object !== helpers });
    const labels = nodes.map((n) => n.label);
    expect(labels).toContain("Root");
    expect(labels).toContain("mixamorig:Hips");
    expect(labels).toContain("Body");
    expect(labels).not.toContain("Helpers");
    expect(labels).not.toContain("GridHelper");
    void bone;
    void mesh;
  });

  it("honors a custom kindOf classifier", () => {
    const group = new THREE.Group();
    const { nodes } = snapshotThreeScene(group, { kindOf: () => "light" });
    expect(nodes[0].kind).toBe("light");
  });
});

describe("threeObjectTransform", () => {
  it("reads position/quaternion/scale into a SceneTransform", () => {
    const object = new THREE.Object3D();
    object.position.set(1, 2, 3);
    object.quaternion.set(0, 0.7071, 0, 0.7071);
    object.scale.set(2, 2, 2);
    expect(threeObjectTransform(object)).toEqual({
      translation: [1, 2, 3],
      rotation: [0, 0.7071, 0, 0.7071],
      scale: [2, 2, 2],
    });
  });
});

describe("createThreeSceneGraphController", () => {
  it("starts empty and publishes a snapshot that notifies subscribers", () => {
    const controller = createThreeSceneGraphController();
    expect(controller.getSnapshot().nodes).toEqual([]);

    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    const { root } = buildSampleScene();
    const snapshot = controller.publish(root);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(controller.getSnapshot().nodes.length).toBeGreaterThan(0);

    unsubscribe();
  });

  it("toggleVisibility flips the live object and republishes a new snapshot with the flipped row", () => {
    const controller = createThreeSceneGraphController();
    const { root, mesh } = buildSampleScene();
    controller.publish(root);

    const listener = vi.fn();
    controller.subscribe(listener);

    expect(mesh.visible).toBe(true);
    const ok = controller.toggleVisibility(mesh.uuid);
    expect(ok).toBe(true);
    expect(mesh.visible).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    const row = controller.getSnapshot().nodes.find((n) => n.id === mesh.uuid);
    expect(row?.visible).toBe(false);
  });

  it("toggleVisibility on an unknown id is a no-op, not an error", () => {
    const controller = createThreeSceneGraphController();
    const { root } = buildSampleScene();
    controller.publish(root);
    expect(controller.toggleVisibility("not-a-real-uuid")).toBe(false);
  });
});
