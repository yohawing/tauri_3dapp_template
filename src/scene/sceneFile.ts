import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isBoundedUtf8String, isWireRecord, isSafeNonNegativeInteger } from "../wireValidation";

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

export const MAX_SCENE_PATH_BYTES = 4_096;
const MAX_SCENE_DISPLAY_NAME_BYTES = 1_024;

/** Keep file-dialog paths within the native Scene command contract. */
export function sceneFilePathError(path: string): Error | null {
  return isBoundedUtf8String(path, MAX_SCENE_PATH_BYTES, true)
    ? null
    : new Error(`Scene path exceeds the ${MAX_SCENE_PATH_BYTES}-byte limit`);
}

function invokeSceneFileAtPath(command: string, path: string): Promise<unknown> {
  const error = sceneFilePathError(path);
  return error ? Promise.reject(error) : invoke<unknown>(command, { path });
}

/** Reject malformed native Scene status payloads before they reach React state. */
export function normalizeSceneFileStatus(value: unknown): SceneFileStatus | null {
  if (!isWireRecord(value)) return null;
  const revision = value.revision;
  if (
    !isSafeNonNegativeInteger(revision) ||
    (value.path !== null && !isBoundedUtf8String(value.path, MAX_SCENE_PATH_BYTES, true)) ||
    !isBoundedUtf8String(value.displayName, MAX_SCENE_DISPLAY_NAME_BYTES) ||
    typeof value.hasDocument !== "boolean" ||
    typeof value.canSave !== "boolean"
  ) {
    return null;
  }
  if (value.canSave !== (value.path !== null)) return null;
  return {
    revision,
    path: value.path,
    displayName: value.displayName,
    hasDocument: value.hasDocument,
    canSave: value.canSave,
  };
}

function requireSceneFileStatus(value: unknown): SceneFileStatus {
  const status = normalizeSceneFileStatus(value);
  if (!status) throw new Error("Invalid Scene file status payload");
  return status;
}

const SCENE_FILTER = [{ name: "Tauri3D Scene", extensions: ["json"] }];
const ASSET_FILTER = [{ name: "3D Asset", extensions: ["gltf", "glb", "fbx"] }];

export function getSceneFileStatus(): Promise<SceneFileStatus> {
  return invoke<unknown>("get_scene_file_status").then(requireSceneFileStatus);
}

export function newSceneFile(): Promise<SceneFileStatus> {
  return invoke<unknown>("new_scene_file").then(requireSceneFileStatus);
}

export async function openSceneFile(): Promise<SceneFileStatus | null> {
  const path = await open({ multiple: false, directory: false, filters: SCENE_FILTER });
  if (path === null) return null;
  return openSceneFileAtPath(path);
}

export function openSceneFileAtPath(path: string): Promise<SceneFileStatus> {
  return invokeSceneFileAtPath("open_scene_file", path).then(requireSceneFileStatus);
}

export async function importSceneAsset(): Promise<SceneFileStatus | null> {
  const path = await open({ multiple: false, directory: false, filters: ASSET_FILTER });
  if (path === null) return null;
  return importSceneAssetAtPath(path);
}

export function importSceneAssetAtPath(path: string): Promise<SceneFileStatus> {
  return invoke<unknown>("import_scene_asset", { path }).then(requireSceneFileStatus);
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
  const error = sceneFilePathError(path);
  return error
    ? Promise.reject(error)
    : invoke<unknown>("save_scene_file", { path }).then(requireSceneFileStatus);
}

export function saveSceneFileToPath(path: string): Promise<SceneFileStatus> {
  return invokeSceneFileAtPath("save_scene_file", path).then(requireSceneFileStatus);
}

export function saveCurrentSceneFile(): Promise<SceneFileStatus> {
  return invoke<unknown>("save_scene_file", { path: null }).then(requireSceneFileStatus);
}
