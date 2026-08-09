import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface SceneFileStatus {
  revision: number;
  path: string | null;
  displayName: string;
  hasDocument: boolean;
  canSave: boolean;
}

export const BUILTIN_SCENE_STATUS: SceneFileStatus = {
  revision: 0,
  path: null,
  displayName: "Built-in Scene",
  hasDocument: false,
  canSave: false,
};

const SCENE_FILTER = [{ name: "Tauri3D Scene", extensions: ["json"] }];
const ASSET_FILTER = [{ name: "3D Asset", extensions: ["gltf", "glb", "fbx"] }];

export function getSceneFileStatus(): Promise<SceneFileStatus> {
  return invoke("get_scene_file_status");
}

export function newSceneFile(): Promise<SceneFileStatus> {
  return invoke("new_scene_file");
}

export async function openSceneFile(): Promise<SceneFileStatus | null> {
  const path = await open({ multiple: false, directory: false, filters: SCENE_FILTER });
  if (path === null) return null;
  return openSceneFileAtPath(path);
}

export function openSceneFileAtPath(path: string): Promise<SceneFileStatus> {
  return invoke("open_scene_file", { path });
}

export async function importSceneAsset(): Promise<SceneFileStatus | null> {
  const path = await open({ multiple: false, directory: false, filters: ASSET_FILTER });
  if (path === null) return null;
  return importSceneAssetAtPath(path);
}

export function importSceneAssetAtPath(path: string): Promise<SceneFileStatus> {
  return invoke("import_scene_asset", { path });
}

export async function saveSceneFile(
  status: SceneFileStatus,
  forceDialog: boolean,
): Promise<SceneFileStatus | null> {
  let path: string | null = status.path;
  if (forceDialog || path === null) {
    path = await save({
      filters: SCENE_FILTER,
      defaultPath: status.path ?? "untitled.scene.json",
    });
    if (path === null) return null;
  }
  return invoke("save_scene_file", { path });
}

export function saveSceneFileToPath(path: string): Promise<SceneFileStatus> {
  return invoke("save_scene_file", { path });
}

export function saveCurrentSceneFile(): Promise<SceneFileStatus> {
  return invoke("save_scene_file", { path: null });
}
