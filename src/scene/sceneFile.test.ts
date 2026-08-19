import { describe, expect, it } from "vitest";
import {
  MAX_SCENE_PATH_BYTES,
  normalizeSceneFileStatus,
  openSceneFileAtPath,
  saveSceneFileToPath,
  sceneFilePathError,
} from "./sceneFile";

describe("Scene file status wire contract", () => {
  it("accepts the native status shape", () => {
    expect(normalizeSceneFileStatus({
      revision: 3,
      path: "C:\\work\\scene.json",
      displayName: "scene.json",
      hasDocument: true,
      canSave: true,
    })).toEqual({
      revision: 3,
      path: "C:\\work\\scene.json",
      displayName: "scene.json",
      hasDocument: true,
      canSave: true,
    });
  });

  it.each([
    null,
    [],
    { revision: -1, path: null, displayName: "Untitled", hasDocument: false, canSave: false },
    { revision: 1.5, path: null, displayName: "Untitled", hasDocument: false, canSave: false },
    { revision: Number.MAX_SAFE_INTEGER + 1, path: null, displayName: "Untitled", hasDocument: false, canSave: false },
    { revision: 1, path: null, displayName: "Untitled", hasDocument: false, canSave: true },
    { revision: 1, path: "scene.json", displayName: "", hasDocument: true, canSave: true },
  ])("rejects malformed payload %#", (payload) => {
    expect(normalizeSceneFileStatus(payload)).toBeNull();
  });

  it("bounds native path and display-name text", () => {
    expect(normalizeSceneFileStatus({
      revision: 1,
      path: `C:\\${"p".repeat(4_093)}.json`,
      displayName: "scene.json",
      hasDocument: true,
      canSave: true,
    })).toBeNull();
    expect(normalizeSceneFileStatus({
      revision: 1,
      path: "C:\\scene.json",
      displayName: "x".repeat(1_025),
      hasDocument: true,
      canSave: true,
    })).toBeNull();
  });

  it("bounds dialog paths by UTF-8 bytes before invoking native commands", async () => {
    const valid = "é".repeat(MAX_SCENE_PATH_BYTES / 2);
    const oversized = `${valid}é`;
    expect(sceneFilePathError(valid)).toBeNull();
    expect(sceneFilePathError(oversized)?.message).toContain(`${MAX_SCENE_PATH_BYTES}-byte`);

    await expect(openSceneFileAtPath(oversized)).rejects.toThrow("Scene path exceeds");
    await expect(saveSceneFileToPath(oversized)).rejects.toThrow("Scene path exceeds");
  });
});
