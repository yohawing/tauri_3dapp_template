import { useCallback, useEffect, useRef, useState } from "react";
import { safeDiagnosticText } from "../console/contracts";
import { createSelfTestTimerBag } from "../selfTestTimers";
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

/**
 * Once a newer successful status is accepted, an older response cannot
 * overwrite it. Failed or cancelled operations do not suppress the startup
 * status because they have no replacement status to accept.
 */
export function shouldAcceptSceneStatus(
  requestGeneration: number,
  acceptedGeneration: number,
): boolean {
  return requestGeneration >= acceptedGeneration;
}

let fileSelfTestHasRun = false;
let assetImportSelfTestHasRun = false;
let assetRoundtripOpenSelfTestHasRun = false;

export function useSceneFileController({
  appendDiagnostic,
  activateNativeRenderer,
  revealConsole,
}: SceneFileControllerOptions): SceneFileController {
  const [status, setStatus] = useState<SceneFileStatus>(BUILTIN_SCENE_STATUS);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const initialStatusRequestedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const acceptedGenerationRef = useRef(0);

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
      if (!mountedRef.current || busyRef.current) return;
      busyRef.current = true;
      const requestGeneration = ++requestGenerationRef.current;
      setBusy(true);
      try {
        const nextStatus = await task();
        if (
          nextStatus &&
          mountedRef.current &&
          shouldAcceptSceneStatus(requestGeneration, acceptedGenerationRef.current)
        ) {
          acceptedGenerationRef.current = requestGeneration;
          acceptStatus(nextStatus, operation, activateNative);
        }
      } catch (error) {
        if (mountedRef.current) {
          appendDiagnostic("error", "scene", `${operation} failed: ${safeDiagnosticText(error)}`);
          revealConsole();
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
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
    if (initialStatusRequestedRef.current) return;
    initialStatusRequestedRef.current = true;
    const requestGeneration = ++requestGenerationRef.current;
    void getSceneFileStatus()
      .then((nextStatus) => {
        if (
          mountedRef.current &&
          shouldAcceptSceneStatus(requestGeneration, acceptedGenerationRef.current)
        ) {
          acceptedGenerationRef.current = requestGeneration;
          setStatus(nextStatus);
        }
      })
      .catch((error) => {
        if (
          mountedRef.current &&
          shouldAcceptSceneStatus(requestGeneration, acceptedGenerationRef.current)
        ) {
          appendDiagnostic("warn", "scene", `Scene file status unavailable: ${safeDiagnosticText(error)}`);
        }
      });
  }, [appendDiagnostic]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    document.title = `${status.displayName} — tauri3d PoC`;
  }, [status.displayName]);

  // Non-interactive end-to-end gate for the Rust file lifecycle. Dialogs are
  // intentionally bypassed here; normal File menu actions still use them.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openPath = import.meta.env.VITE_FILE_SELF_TEST_OPEN;
    const savePath = import.meta.env.VITE_FILE_SELF_TEST_SAVE;
    const invalidOpenPath = import.meta.env.VITE_FILE_SELF_TEST_INVALID_OPEN;
    if (fileSelfTestHasRun || !openPath || !savePath) return;
    fileSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    timers.schedule(() => {
      void runOperation("Self-test Open Scene", true, () => openSceneFileAtPath(openPath));
    }, 2000);
    timers.schedule(() => {
      void runOperation("Self-test Save Scene As", false, () => saveSceneFileToPath(savePath));
    }, 4500);
    timers.schedule(() => {
      if (invalidOpenPath) {
        void runOperation("Self-test Expected-failure Open Scene", false, () =>
          openSceneFileAtPath(invalidOpenPath),
        );
      }
    }, 6500);
    timers.schedule(() => {
      void runOperation("Self-test Save Scene", false, saveCurrentSceneFile);
    }, 8500);
    timers.schedule(() => {
      void runOperation("Self-test New Scene", true, newSceneFile).finally(() => {
        completed = true;
      });
    }, 10500);
    return () => {
      timers.cancel();
      if (!completed) fileSelfTestHasRun = false;
    };
  }, [runOperation]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const importPath = import.meta.env.VITE_ASSET_IMPORT_SELF_TEST;
    const invalidImportPath = import.meta.env.VITE_ASSET_IMPORT_INVALID_SELF_TEST;
    const savePath = import.meta.env.VITE_ASSET_IMPORT_SAVE_SELF_TEST;
    if (assetImportSelfTestHasRun || !importPath) return;
    assetImportSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    appendDiagnostic("info", "scene", `Self-test Import scheduled: ${importPath}`);
    void (async () => {
      if (!(await timers.delay(2000))) return;
      await runOperation("Self-test Import Asset", true, () => importSceneAssetAtPath(importPath));
      if (timers.isCancelled()) return;
      if (savePath) {
        await runOperation("Self-test Save Imported Scene", false, () => saveSceneFileToPath(savePath));
      }
      if (timers.isCancelled()) return;
      if (invalidImportPath) {
        await runOperation("Self-test Expected-failure Import Asset", false, () =>
          importSceneAssetAtPath(invalidImportPath),
        );
      }
      completed = true;
    })().catch((error) => {
      if (!timers.isCancelled() && mountedRef.current) {
      appendDiagnostic("error", "scene", `Scene self-test failed: ${safeDiagnosticText(error)}`);
        revealConsole();
      }
    });
    return () => {
      timers.cancel();
      if (!completed) assetImportSelfTestHasRun = false;
    };
  }, [appendDiagnostic, revealConsole, runOperation]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openPath = import.meta.env.VITE_ASSET_ROUNDTRIP_OPEN_SELF_TEST;
    if (assetRoundtripOpenSelfTestHasRun || !openPath) return;
    assetRoundtripOpenSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    timers.schedule(() => {
      void runOperation("Self-test Open Imported Scene", true, () => openSceneFileAtPath(openPath)).finally(() => {
        completed = true;
      });
    }, 2000);
    return () => {
      timers.cancel();
      if (!completed) assetRoundtripOpenSelfTestHasRun = false;
    };
  }, [runOperation]);

  return { status, busy, newScene, openScene, importAsset, saveScene, saveSceneAs };
}
