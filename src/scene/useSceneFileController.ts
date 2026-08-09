import { useCallback, useEffect, useRef, useState } from "react";
import { requestViewportRemeasure } from "../viewport/ViewportHost";
import {
  BUILTIN_SCENE_STATUS,
  getSceneFileStatus,
  importSceneAsset,
  importSceneAssetAtPath,
  newSceneFile,
  openSceneFile,
  openSceneFileAtPath,
  saveCurrentSceneFile,
  saveSceneFile,
  saveSceneFileToPath,
  type SceneFileStatus,
} from "./sceneFile";

type AppendSceneDiagnostic = (
  level: "info" | "warn" | "error",
  source: "scene",
  message: string,
) => void;

interface SceneFileControllerOptions {
  appendDiagnostic: AppendSceneDiagnostic;
  activateNativeRenderer: () => void;
  revealConsole: () => void;
}

export interface SceneFileController {
  status: SceneFileStatus;
  busy: boolean;
  newScene: () => void;
  openScene: () => void;
  importAsset: () => void;
  saveScene: () => void;
  saveSceneAs: () => void;
}

let fileSelfTestHasRun = false;
let assetImportSelfTestHasRun = false;

export function useSceneFileController({
  appendDiagnostic,
  activateNativeRenderer,
  revealConsole,
}: SceneFileControllerOptions): SceneFileController {
  const [status, setStatus] = useState<SceneFileStatus>(BUILTIN_SCENE_STATUS);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const acceptStatus = useCallback(
    (nextStatus: SceneFileStatus, operation: string, activateNative: boolean) => {
      setStatus(nextStatus);
      if (activateNative) activateNativeRenderer();
      window.dispatchEvent(new Event("tauri3d:scene-file-changed"));
      appendDiagnostic("info", "scene", `${operation}: ${nextStatus.displayName}`);
      requestViewportRemeasure();
    },
    [activateNativeRenderer, appendDiagnostic],
  );

  const runOperation = useCallback(
    async (
      operation: string,
      activateNative: boolean,
      task: () => Promise<SceneFileStatus | null>,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const nextStatus = await task();
        if (nextStatus) acceptStatus(nextStatus, operation, activateNative);
      } catch (error) {
        appendDiagnostic("error", "scene", `${operation} failed: ${String(error)}`);
        revealConsole();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [acceptStatus, appendDiagnostic, revealConsole],
  );

  const newScene = useCallback(() => {
    void runOperation("New Scene", true, newSceneFile);
  }, [runOperation]);
  const openScene = useCallback(() => {
    void runOperation("Open Scene", true, openSceneFile);
  }, [runOperation]);
  const importAsset = useCallback(() => {
    void runOperation("Import Asset", true, importSceneAsset);
  }, [runOperation]);
  const saveScene = useCallback(() => {
    void runOperation("Save Scene", false, () => saveSceneFile(status, false));
  }, [runOperation, status]);
  const saveSceneAs = useCallback(() => {
    void runOperation("Save Scene As", false, () => saveSceneFile(status, true));
  }, [runOperation, status]);

  useEffect(() => {
    void getSceneFileStatus().then(setStatus).catch((error) => {
      appendDiagnostic("warn", "scene", `Scene file status unavailable: ${String(error)}`);
    });
  }, [appendDiagnostic]);

  useEffect(() => {
    document.title = `${status.displayName} — tauri3d PoC`;
  }, [status.displayName]);

  // Non-interactive end-to-end gate for the Rust file lifecycle. Dialogs are
  // intentionally bypassed here; normal File menu actions still use them.
  useEffect(() => {
    const openPath = import.meta.env.VITE_FILE_SELF_TEST_OPEN;
    const savePath = import.meta.env.VITE_FILE_SELF_TEST_SAVE;
    const invalidOpenPath = import.meta.env.VITE_FILE_SELF_TEST_INVALID_OPEN;
    if (fileSelfTestHasRun || !openPath || !savePath) return;
    fileSelfTestHasRun = true;
    window.setTimeout(() => {
      void runOperation("Self-test Open Scene", true, () => openSceneFileAtPath(openPath));
    }, 2000);
    window.setTimeout(() => {
      void runOperation("Self-test Save Scene As", false, () => saveSceneFileToPath(savePath));
    }, 4500);
    window.setTimeout(() => {
      if (invalidOpenPath) {
        void runOperation("Self-test Expected-failure Open Scene", false, () =>
          openSceneFileAtPath(invalidOpenPath),
        );
      }
    }, 6500);
    window.setTimeout(() => {
      void runOperation("Self-test Save Scene", false, saveCurrentSceneFile);
    }, 8500);
    window.setTimeout(() => {
      void runOperation("Self-test New Scene", true, newSceneFile);
    }, 10500);
  }, [runOperation]);

  useEffect(() => {
    const importPath = import.meta.env.VITE_ASSET_IMPORT_SELF_TEST;
    const invalidImportPath = import.meta.env.VITE_ASSET_IMPORT_INVALID_SELF_TEST;
    if (assetImportSelfTestHasRun || !importPath) return;
    assetImportSelfTestHasRun = true;
    appendDiagnostic("info", "scene", `Self-test Import scheduled: ${importPath}`);
    window.setTimeout(() => {
      void runOperation("Self-test Import Asset", true, () => importSceneAssetAtPath(importPath));
    }, 2000);
    if (invalidImportPath) {
      window.setTimeout(() => {
        void runOperation("Self-test Expected-failure Import Asset", false, () =>
          importSceneAssetAtPath(invalidImportPath),
        );
      }, 20000);
    }
  }, [appendDiagnostic, runOperation]);

  return { status, busy, newScene, openScene, importAsset, saveScene, saveSceneAs };
}
