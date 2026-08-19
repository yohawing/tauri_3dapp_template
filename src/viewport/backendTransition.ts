import type { CameraState, CanvasBackendHandle } from "./canvasBackend";

export type BackendTransitionMode = "native" | "canvas";

export interface BackendTransitionDependencies {
  deactivateNative: () => Promise<void>;
  /** Resolves after the previous Native input attachment has drained its IPC tail. */
  waitForViewportInputIdle?: () => Promise<void>;
  activateNative: () => Promise<void>;
  readCamera: () => Promise<CameraState>;
  writeCamera: (camera: CameraState) => Promise<void>;
  prepareCanvas: () => Promise<(camera: CameraState) => CanvasBackendHandle>;
  reportError: (error: unknown) => void;
}

interface TransitionState {
  generation: number;
  mode: BackendTransitionMode;
  nativeDeactivated: boolean;
  restoring: boolean;
  canvasHandle: CanvasBackendHandle | null;
  cancelled: boolean;
  seedCamera?: CameraState;
}

type TransitionCleanup = () => void;

/**
 * Owns the generation that is allowed to mutate the renderer lifecycle.
 * React effects only start transitions; all asynchronous ordering and cleanup
 * stays here so an older effect cannot mount Canvas or reactivate Native after
 * a newer mode has taken ownership.
 */
export class BackendTransitionController {
  private generation = 0;
  private current: TransitionState | null = null;
  private pendingCamera: CameraState | undefined;
  private disposed = false;
  private compensationTail: Promise<void> = Promise.resolve();
  private nativeDeactivationInFlight: {
    owner: TransitionState;
    promise: Promise<void>;
  } | null = null;

  public constructor(private readonly dependencies: BackendTransitionDependencies) {}

  /** Apply a live update only when the current Canvas generation is mounted. */
  public updateCanvas(update: (handle: CanvasBackendHandle) => void): void {
    const state = this.current;
    if (!state || state.cancelled || state.mode !== "canvas" || !state.canvasHandle) return;
    try {
      update(state.canvasHandle);
    } catch (error) {
      this.dependencies.reportError(error);
    }
  }

  /** Start a mode transition and return the generation-owned cleanup. */
  public transition(mode: BackendTransitionMode): TransitionCleanup {
    if (this.disposed) {
      return () => undefined;
    }

    const previous = this.current;
    if (previous) {
      this.replace(previous);
    }

    const state: TransitionState = {
      generation: ++this.generation,
      mode,
      nativeDeactivated: false,
      restoring: false,
      canvasHandle: null,
      cancelled: false,
      seedCamera: this.takePendingCamera(),
    };
    this.current = state;
    if (mode === "canvas") {
      void this.enterCanvas(state);
    } else {
      void this.enterNative(state);
    }

    return () => this.cancel(state);
  }

  /** Idempotent component-lifetime cleanup. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    const current = this.current;
    if (current) {
      this.cancel(current, true);
    }
    this.disposed = true;
  }

  private takePendingCamera(): CameraState | undefined {
    const camera = this.pendingCamera;
    this.pendingCamera = undefined;
    return camera;
  }

  /**
   * Synchronously tears down a previous Canvas generation. The next
   * generation owns the returned camera handoff; the old generation performs
   * no asynchronous writes or activation after replacement.
   */
  private replace(state: TransitionState): void {
    if (this.current !== state || state.cancelled) {
      return;
    }
    state.cancelled = true;
    this.current = null;
    const handle = state.canvasHandle;
    state.canvasHandle = null;
    if (handle) {
      this.pendingCamera = this.disposeCanvas(handle);
    }
  }

  private cancel(state: TransitionState, allowDisposed = false): void {
    if (state.cancelled || this.current !== state) {
      return;
    }
    state.cancelled = true;
    this.current = null;
    const handle = state.canvasHandle;
    state.canvasHandle = null;
    const finalCamera = handle ? this.disposeCanvas(handle) : undefined;
    if (finalCamera) {
      this.pendingCamera = finalCamera;
    }
    if (!state.nativeDeactivated && !finalCamera) {
      state.restoring = false;
      return;
    }
    state.restoring = true;
    void this.restoreAfterCancellation(state, finalCamera, allowDisposed);
  }

  private disposeCanvas(handle: CanvasBackendHandle): CameraState | undefined {
    try {
      return handle.dispose();
    } catch (error) {
      this.dependencies.reportError(error);
      return undefined;
    }
  }

  private isCurrent(state: TransitionState): boolean {
    return !this.disposed && !state.cancelled && this.current === state;
  }

  /**
   * Share a Native deactivation only within the Canvas owner that requested
   * it. A stale Native activation can race the owner's Canvas entry; issuing
   * a second deactivate in that window is redundant and can reorder renderer
   * lifecycle calls. Different generations retain their existing compensation
   * semantics and may request their own operation.
   */
  private deactivateNative(owner: TransitionState): Promise<void> {
    const inFlight = this.nativeDeactivationInFlight;
    if (inFlight?.owner === owner) {
      return inFlight.promise;
    }

    let operation: Promise<void>;
    try {
      operation = this.dependencies.deactivateNative();
    } catch (error) {
      operation = Promise.reject(error);
    }
    this.nativeDeactivationInFlight = { owner, promise: operation };
    const clearInFlight = () => {
      if (this.nativeDeactivationInFlight?.promise === operation) {
        this.nativeDeactivationInFlight = null;
      }
    };
    void operation.then(clearInFlight, clearInFlight);
    return operation;
  }

  private canRestore(state: TransitionState, allowDisposed: boolean): boolean {
    const currentOrCancelled = this.current === state || (state.cancelled && this.current === null);
    return (
      currentOrCancelled &&
      this.generation === state.generation &&
      (!this.disposed || allowDisposed || state.restoring)
    );
  }

  private async restoreAfterCancellation(
    state: TransitionState,
    finalCamera: CameraState | undefined,
    allowDisposed: boolean,
  ): Promise<void> {
    if (!this.canRestore(state, allowDisposed)) {
      state.restoring = false;
      return;
    }
    if (finalCamera) {
      try {
        await this.dependencies.writeCamera(finalCamera);
      } catch (error) {
        this.dependencies.reportError(error);
      }
    }
    if (!this.canRestore(state, allowDisposed)) {
      state.restoring = false;
      return;
    }
    if (!state.nativeDeactivated && !finalCamera) {
      return;
    }
    try {
      await this.dependencies.activateNative();
      state.nativeDeactivated = false;
    } catch (error) {
      this.dependencies.reportError(error);
    }
    state.restoring = false;
  }

  private async enterCanvas(state: TransitionState): Promise<void> {
    try {
      await this.compensationTail;
      if (!this.isCurrent(state)) {
        return;
      }
      if (this.dependencies.waitForViewportInputIdle) {
        // The Native input effect cleanup queues PointerCancel and publishes
        // its attachment tail before this transition effect starts Canvas.
        // Keep deactivation behind that tail so late old input cannot enter a
        // later Native generation.
        await this.dependencies.waitForViewportInputIdle();
        if (!this.isCurrent(state)) {
          return;
        }
      }
      await this.deactivateNative(state);
      state.nativeDeactivated = true;
      if (!this.isCurrent(state)) {
        if (state.cancelled && this.generation === state.generation && this.current === null) {
          state.restoring = true;
          await this.restoreAfterCancellation(state, undefined, true);
        } else {
          this.compensateLateDeactivation();
        }
        return;
      }

      const mountCanvas = await this.dependencies.prepareCanvas();
      if (!this.isCurrent(state)) {
        return;
      }

      const camera = state.seedCamera ?? (await this.dependencies.readCamera());
      if (!this.isCurrent(state)) {
        return;
      }
      const handle = mountCanvas(camera);
      if (!this.isCurrent(state)) {
        this.disposeCanvas(handle);
        return;
      }
      state.canvasHandle = handle;
    } catch (error) {
      if (!this.isCurrent(state)) {
        return;
      }
      this.dependencies.reportError(error);
      await this.restoreAfterCancellation(state, undefined, false);
    }
  }

  /**
   * A Canvas generation may finish deactivating after a newer Native
   * generation has already become current. Queue a Native reactivation for
   * that owner, and make later Canvas generations wait for it so a delayed
   * activation cannot turn Canvas back on after it has mounted.
   */
  private compensateLateDeactivation(): void {
    const owner = this.current;
    if (!owner || owner.mode !== "native") {
      return;
    }
    this.compensationTail = this.compensationTail
      .then(async () => {
        if (this.current !== owner || owner.cancelled || this.disposed) {
          return;
        }
        try {
          await this.dependencies.activateNative();
        } catch (error) {
          if (this.current === owner && !owner.cancelled) {
            this.dependencies.reportError(error);
          }
        }
      })
      .catch(() => undefined);
  }

  private async enterNative(state: TransitionState): Promise<void> {
    if (state.seedCamera) {
      try {
        await this.dependencies.writeCamera(state.seedCamera);
      } catch (error) {
        this.dependencies.reportError(error);
      }
      if (!this.isCurrent(state)) {
        return;
      }
    }
    try {
      await this.dependencies.activateNative();
      if (!this.isCurrent(state)) {
        this.compensateLateActivation();
        return;
      }
      state.nativeDeactivated = false;
    } catch (error) {
      if (this.isCurrent(state)) {
        this.dependencies.reportError(error);
      }
    }
  }

  /**
   * A Native generation may finish activating after a newer Canvas generation
   * has already deactivated and mounted. Queue a Native deactivation for that
   * current Canvas owner, and let later Canvas generations wait for it through
   * the shared compensation tail.
   */
  private compensateLateActivation(): void {
    const owner = this.current;
    if (!owner || owner.mode !== "canvas") {
      return;
    }
    this.compensationTail = this.compensationTail
      .then(async () => {
        if (this.current !== owner || owner.cancelled || this.disposed) {
          return;
        }
        try {
          if (this.dependencies.waitForViewportInputIdle) {
            await this.dependencies.waitForViewportInputIdle();
            if (this.current !== owner || owner.cancelled || this.disposed) {
              return;
            }
          }
          await this.deactivateNative(owner);
          owner.nativeDeactivated = true;
        } catch (error) {
          if (this.current === owner && !owner.cancelled) {
            this.dependencies.reportError(error);
          }
        }
      })
      .catch(() => undefined);
  }
}
