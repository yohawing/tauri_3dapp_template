import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { ConsoleSource } from "../console/contracts";

export interface LazyPanelBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  source: ConsoleSource;
  diagnosticMessage: (error: unknown) => string;
  onError?: (error: unknown, info: ErrorInfo) => void;
}

/** Keep keyboard focus on the stable Dockview host across lazy retries. */
export function focusLazyPanelHost(target: EventTarget | null): void {
  if (typeof Element === "undefined" || !(target instanceof Element)) return;
  const host = target.closest<HTMLElement>("[data-lazy-panel-host]");
  if (!host) return;
  // The Dockview host survives the retry state update, so focus it before
  // the Retry button is unmounted. Synchronous focus avoids a late RAF
  // stealing focus from a subsequent Tab or native dialog interaction.
  if (host.isConnected) host.focus();
}

interface LazyPanelBoundaryState {
  failed: boolean;
}

/** Shared retryable boundary for panel-level dynamic imports. */
export class LazyPanelBoundary extends Component<
  LazyPanelBoundaryProps,
  LazyPanelBoundaryState
> {
  public state: LazyPanelBoundaryState = { failed: false };

  public static getDerivedStateFromError(): LazyPanelBoundaryState {
    return { failed: true };
  }

  public componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      this.props.onError?.(error, info);
    } catch (callbackError) {
      // Error reporting must not replace the boundary's fallback path.
      console.error("[LazyPanelBoundary] onError callback failed", callbackError);
    }
    let message = "Panel failed to load";
    try {
      const candidate = this.props.diagnosticMessage(error);
      if (typeof candidate === "string" && candidate.length > 0) message = candidate;
    } catch (diagnosticError) {
      console.error("[LazyPanelBoundary] diagnostic message failed", diagnosticError);
    }
    window.dispatchEvent(
      new CustomEvent("tauri3d:diagnostic", {
        detail: {
          level: "error",
          source: this.props.source,
          message,
        },
      }),
    );
  }

  public render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback;
  }
}
