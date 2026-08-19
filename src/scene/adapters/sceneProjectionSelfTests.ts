import type { SceneCommand, SceneProjection } from "../core/projection";

export interface SceneProjectionSelfTestHost {
  getSnapshot(): SceneProjection;
  select(nodeId: string): Promise<void>;
  dispatch(command: SceneCommand): Promise<void>;
}

export interface SceneProjectionSelfTestFlags {
  scene?: string;
  material?: string;
  visibility?: string;
}

export function installSceneProjectionSelfTests(
  host: SceneProjectionSelfTestHost,
  flags: SceneProjectionSelfTestFlags,
): () => void {
  const timers = new Set<number>();
  let disposed = false;

  const schedule = (callback: () => void, delayMs: number): void => {
    if (disposed) return;
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, delayMs);
    timers.add(timer);
  };

  const logVisibilityResult = (step: string, nodeId: string): void => {
    const result = [...host.getSnapshot().commandResults]
      .reverse()
      .find((candidate) => candidate.nodeId === nodeId && candidate.property === "visibility");
    const visible = host.getSnapshot().nodes.find((node) => node.id === nodeId)?.visible;
    const message =
      `[visibility-self-test] step=${step} node=${nodeId} sequence=${result?.sequence ?? "pending"} ` +
      `applied=${result?.applied ?? "pending"} visible=${visible ?? "missing"}`;
    console.log(message);
    window.dispatchEvent(
      new CustomEvent("tauri3d:diagnostic", {
        detail: { level: "info", source: "scene", message },
      }),
    );
    window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }));
  };

  if (flags.scene) {
    schedule(() => {
      console.log("[scene-self-test] select=key-light");
      void host.select("key-light");
    }, 2500);
  }
  if (flags.material) {
    schedule(() => {
      console.log("[material-self-test] color=#2dc8ff metallic=0.8 roughness=0.2");
      void host.dispatch({ type: "setBaseColor", nodeId: "cube", color: [0.176, 0.784, 1, 1] });
      void host.dispatch({ type: "setMetallic", nodeId: "cube", value: 0.8 });
      void host.dispatch({ type: "setRoughness", nodeId: "cube", value: 0.2 });
    }, 2500);
  }
  if (flags.visibility) {
    if (flags.visibility === "instance-hide") {
      const findInstance = (attempt: number): void => {
        const nodeId = host
          .getSnapshot()
          .nodes.find((node) => node.parent === "scene" && node.kind === "mesh" && node.id !== "cube")?.id;
        if (nodeId) {
          console.log(`[visibility-self-test] step=hide instance=${nodeId}`);
          void host.dispatch({ type: "setVisibility", nodeId, visible: false });
          schedule(() => logVisibilityResult("hide", nodeId), 1500);
          return;
        }
        if (attempt < 12) {
          schedule(() => findInstance(attempt + 1), 250);
          return;
        }
        console.log("[visibility-self-test] step=hide instance=missing");
      };
      schedule(() => findInstance(0), 2500);
    } else {
      schedule(() => {
        const nodeId = "cube";
        console.log(`[visibility-self-test] step=hide cube=${nodeId}`);
        void host.dispatch({ type: "setVisibility", nodeId, visible: false });
        schedule(() => logVisibilityResult("hide", nodeId), 1500);
        schedule(() => {
          console.log(`[visibility-self-test] step=show cube=${nodeId}`);
          void host.dispatch({ type: "setVisibility", nodeId, visible: true });
        }, 1500);
        schedule(() => logVisibilityResult("show", nodeId), 3000);
      }, 2500);
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };
}
