import { invoke } from "@tauri-apps/api/core";

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
