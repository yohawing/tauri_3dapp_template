import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isBoundedUtf8String, isWireRecord } from "../wireValidation";

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

const MAX_RENDERER_STATUS_TEXT_BYTES = 4_096;

/** Reject malformed Tauri payloads before they can affect renderer lifecycle state. */
export function normalizeRendererStatus(value: unknown): RendererStatus | null {
  if (!isWireRecord(value)) return null;
  if (typeof value.nativeAvailable !== "boolean" || typeof value.nativeActive !== "boolean") {
    return null;
  }
  if (value.nativeActive && !value.nativeAvailable) return null;
  if (
    (value.fallbackReason !== null && !isBoundedUtf8String(value.fallbackReason, MAX_RENDERER_STATUS_TEXT_BYTES, true)) ||
    (value.recoveryHint !== null && !isBoundedUtf8String(value.recoveryHint, MAX_RENDERER_STATUS_TEXT_BYTES, true))
  ) {
    return null;
  }
  return {
    nativeAvailable: value.nativeAvailable,
    nativeActive: value.nativeActive,
    fallbackReason: value.fallbackReason,
    recoveryHint: value.recoveryHint,
  };
}

export async function getRendererStatus(): Promise<RendererStatus> {
  const status = normalizeRendererStatus(await invoke<unknown>("get_renderer_status"));
  if (!status) throw new Error("Invalid renderer status payload");
  return status;
}

export function onRendererStatusChanged(
  listener: (status: RendererStatus) => void,
): Promise<UnlistenFn> {
  return listen<unknown>("renderer-status-changed", (event) => {
    const status = normalizeRendererStatus(event.payload);
    if (status) listener(status);
  });
}
