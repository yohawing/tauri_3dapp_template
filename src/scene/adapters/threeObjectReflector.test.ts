import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { reflectThreeObject, type ReflectedField, type ReflectedGroup } from "./threeObjectReflector";

function findGroup(groups: ReflectedGroup[], title: string): ReflectedGroup | undefined {
  return groups.find((group) => group.title === title);
}

function findField(group: ReflectedGroup | undefined, key: string): ReflectedField | undefined {
  return group?.fields.find((field) => field.key === key);
}

describe("reflectThreeObject", () => {
  it("reflects only the common Object/Transform groups for a plain Object3D", () => {
    const object = new THREE.Object3D();
    object.name = "Empty";

    const { groups, objectId } = reflectThreeObject(object);

    expect(objectId).toBe(object.uuid);
    expect(groups.map((group) => group.title)).toEqual(["Object", "Transform"]);
    expect(findField(findGroup(groups, "Object"), "name")?.get()).toBe("Empty");
    expect(findField(findGroup(groups, "Object"), "visible")?.get()).toBe(true);
  });

  it("falls back to object.type for an unnamed object's name field", () => {
    const object = new THREE.Group();
    expect(findField(findGroup(reflectThreeObject(object).groups, "Object"), "name")?.get()).toBe("Group");
  });

  it("writes visible back to the object and notifies", () => {
    const object = new THREE.Object3D();
    const onChange = vi.fn();
    const field = findField(findGroup(reflectThreeObject(object, onChange).groups, "Object"), "visible")!;

    field.set(false);

    expect(object.visible).toBe(false);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("ignores a name write (read-only) without throwing or notifying", () => {
    const object = new THREE.Object3D();
    object.name = "Original";
    const onChange = vi.fn();
    const field = findField(findGroup(reflectThreeObject(object, onChange).groups, "Object"), "name")!;

    field.set("Renamed");

    expect(object.name).toBe("Original");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reflects and writes back position/rotation/scale as vector3 fields", () => {
    const object = new THREE.Object3D();
    const onChange = vi.fn();
    const { groups } = reflectThreeObject(object, onChange);
    const transform = findGroup(groups, "Transform")!;

    const position = findField(transform, "position")!;
    expect(position.get()).toEqual({ x: 0, y: 0, z: 0 });
    position.set({ x: 1, y: 2, z: 3 });
    expect(object.position.toArray()).toEqual([1, 2, 3]);
    expect(onChange).toHaveBeenCalledOnce();

    const rotation = findField(transform, "rotation")!;
    rotation.set({ x: 0.1, y: 0.2, z: 0.3 });
    expect([object.rotation.x, object.rotation.y, object.rotation.z]).toEqual([0.1, 0.2, 0.3]);

    const scale = findField(transform, "scale")!;
    scale.set({ x: 2, y: 2, z: 2 });
    expect(object.scale.toArray()).toEqual([2, 2, 2]);
  });

  it("rejects a non-finite vector3 write", () => {
    const object = new THREE.Object3D();
    const onChange = vi.fn();
    const position = findField(
      findGroup(reflectThreeObject(object, onChange).groups, "Transform"),
      "position",
    )!;

    position.set({ x: Number.NaN, y: 0, z: 0 });

    expect(object.position.toArray()).toEqual([0, 0, 0]);
    expect(onChange).not.toHaveBeenCalled();
  });

  describe.each([
    ["DirectionalLight", () => new THREE.DirectionalLight(0xff0000, 2), ["color", "intensity"], ["distance", "decay", "groundColor"]],
    ["AmbientLight", () => new THREE.AmbientLight(0x00ff00, 1), ["color", "intensity"], ["distance", "decay", "groundColor"]],
    [
      "PointLight",
      () => new THREE.PointLight(0x0000ff, 1, 50, 3),
      ["color", "intensity", "distance", "decay"],
      ["groundColor"],
    ],
    [
      "HemisphereLight",
      () => new THREE.HemisphereLight(0xffffff, 0x000000, 1),
      ["color", "intensity", "groundColor"],
      ["distance", "decay"],
    ],
  ])("%s", (_name, makeLight, expectedFields, unexpectedFields) => {
    it(`reflects exactly the applicable Light fields (${expectedFields.join(", ")})`, () => {
      const light = makeLight();
      const group = findGroup(reflectThreeObject(light).groups, "Light");
      expect(group).toBeDefined();
      const keys = group!.fields.map((field) => field.key);
      for (const key of expectedFields) expect(keys).toContain(key);
      for (const key of unexpectedFields) expect(keys).not.toContain(key);
    });

    it("writes intensity and color back to the light", () => {
      const light = makeLight();
      const onChange = vi.fn();
      const group = findGroup(reflectThreeObject(light, onChange).groups, "Light")!;

      findField(group, "intensity")!.set(5);
      expect(light.intensity).toBe(5);

      findField(group, "color")!.set("#00ff00");
      expect(light.color.getHexString()).toBe("00ff00");
      expect(onChange).toHaveBeenCalledTimes(2);
    });
  });

  it("reflects Mesh material color/opacity/wireframe/metalness/roughness when present", () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
    const group = findGroup(reflectThreeObject(mesh).groups, "Material");
    expect(group).toBeDefined();
    const keys = group!.fields.map((field) => field.key);
    expect(keys).toEqual(expect.arrayContaining(["color", "opacity", "wireframe", "metalness", "roughness"]));
  });

  it("omits metalness/roughness for a material that doesn't have them", () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    const group = findGroup(reflectThreeObject(mesh).groups, "Material")!;
    const keys = group.fields.map((field) => field.key);
    expect(keys).toContain("color");
    expect(keys).not.toContain("metalness");
    expect(keys).not.toContain("roughness");
  });

  it("writes back material color/opacity/wireframe/metalness/roughness and notifies", () => {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    const onChange = vi.fn();
    const group = findGroup(reflectThreeObject(mesh, onChange).groups, "Material")!;

    findField(group, "color")!.set("#123456");
    expect(material.color.getHexString()).toBe("123456");

    findField(group, "opacity")!.set(0.5);
    expect(material.opacity).toBe(0.5);

    findField(group, "wireframe")!.set(true);
    expect(material.wireframe).toBe(true);

    findField(group, "metalness")!.set(0.25);
    expect(material.metalness).toBe(0.25);

    findField(group, "roughness")!.set(0.75);
    expect(material.roughness).toBe(0.75);

    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it("has no Material group for a Mesh with an array of materials", () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [
      new THREE.MeshBasicMaterial(),
      new THREE.MeshBasicMaterial(),
    ]);
    const group = findGroup(reflectThreeObject(mesh).groups, "Material");
    expect(group).toBeUndefined();
  });

  it("has no Light or Material group for a non-light, non-mesh object (e.g. a Bone)", () => {
    const bone = new THREE.Bone();
    const { groups } = reflectThreeObject(bone);
    expect(groups.map((group) => group.title)).toEqual(["Object", "Transform"]);
  });

  it("rejects an invalid hex color write", () => {
    const light = new THREE.DirectionalLight();
    const onChange = vi.fn();
    const color = findField(findGroup(reflectThreeObject(light, onChange).groups, "Light"), "color")!;
    const before = light.color.getHexString();

    color.set("not-a-color");

    expect(light.color.getHexString()).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });
});
