import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface RendererStatus {
  nativeAvailable: boolean;
  nativeActive: boolean;
  fallbackReason: string | null;
  recoveryHint: string | null;
}

export const AVAILABLE_RENDERER_STATUS: RendererStatus = {
  nativeAvailable: true,
  nativeActive: true,
  fallbackReason: null,
  recoveryHint: null,
};

export function getRendererStatus(): Promise<RendererStatus> {
  return invoke("get_renderer_status");
}

export function onRendererStatusChanged(
  listener: (status: RendererStatus) => void,
): Promise<UnlistenFn> {
  return listen<RendererStatus>("renderer-status-changed", (event) => listener(event.payload));
}
