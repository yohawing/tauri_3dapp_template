# Plan 001: Make backend lifecycle transitions transactional

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> on any condition in “STOP conditions”; do not improvise. When done, update
> only plan 001's row in `plans/README.md` unless a reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat df95e79..HEAD -- src/viewport/ViewportHost.tsx src/viewport/backendTransition.ts src/viewport/backendTransition.test.ts src-tauri/src/renderer_status.rs src-tauri/src/lib.rs`
> If an in-scope file changed, compare the excerpts below with live code. Any
> behavioral mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `df95e79`, 2026-08-10

## Why this matters

Native/Canvas switching currently has two independent races. Frontend cleanup
reactivates Native only after a Canvas handle exists, so a rapid switch or mount
failure can leave the UI in Native mode while Native drawing remains stopped.
Rust separately stores `nativeActive` in a status mutex and a standalone atomic,
so Device/Surface Lost can race with reactivation and leave them inconsistent.
This plan makes the transition fail-closed without changing Canvas's intentionally
lossy fallback role.

## Current state

- `src/viewport/ViewportHost.tsx` owns Canvas mount, Camera handoff, and Native
  activation in one React effect.
- `src-tauri/src/renderer_status.rs` owns the serializable renderer status.
- `src-tauri/src/lib.rs` owns a separate `RendererActive(AtomicBool)` used by the
  render loop and Device/Surface Lost callbacks.

Current Frontend cleanup (`src/viewport/ViewportHost.tsx:334-353`):

```ts
await safeInvoke("set_renderer_active", { active: false });
const camera = (await safeInvoke<CameraState>("get_camera")) ?? DEFAULT_CAMERA;
if (cancelled) return;
handle = mountCanvasBackend(el, camera);

return () => {
  cancelled = true;
  if (handle) {
    const finalCamera = handle.dispose();
    void safeInvoke("set_camera", { camera: finalCamera });
    void safeInvoke("set_renderer_active", { active: true });
  }
};
```

Current Rust split state (`src-tauri/src/lib.rs:278-285`):

```rust
let next = status.set_active(active)?;
state.0.store(active, Ordering::Relaxed);
Ok(next)
```

Design constraints:

- `docs/IDEA.md:91-103`: only `ViewportHost` switches renderer backend; Canvas
  mode stops or hides Native drawing.
- `TODO.md:13`: Native is primary; Canvas is a minimal fallback.
- `TODO.md:53`: do not mix renderer lifecycle with surface/viewport resize.
- A constructed Kiss3D renderer must remain parked on the event-loop thread in
  unavailable mode; do not drop/recreate it as part of this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Frontend focused | `rtk npx vitest run src/viewport/backendTransition.test.ts` | exit 0; all new transition cases pass |
| Rust focused | `rtk cargo test --locked --manifest-path src-tauri/Cargo.toml renderer_status` | exit 0; lifecycle tests pass |
| Typecheck | `rtk npx tsc --noEmit` | exit 0; no errors |
| Full Frontend | `rtk npm run test` | exit 0; at least 41 existing plus new tests pass |
| Full Rust | `rtk cargo test --locked --manifest-path src-tauri/Cargo.toml` | exit 0; at least 63 existing plus new tests pass |
| Build | `rtk npm run build` | exit 0 |

## Suggested executor toolkit

- Use `rust-coverage-meaningful-tests` if available for the lifecycle invariants
  and interleaving tests; do not add line-execution-only tests.
- Use `screenshot-ui` for the final Tauri window capture.

## Scope

**In scope**:

- `src/viewport/ViewportHost.tsx`
- `src/viewport/backendTransition.ts` (create)
- `src/viewport/backendTransition.test.ts` (create)
- `src-tauri/src/renderer_status.rs`
- `src-tauri/src/lib.rs`

**Out of scope**:

- `vendor/kiss3d-toon/**`
- Surface error classification, surface resize, viewport rectangle calculation
- Canvas scene parity, asset playback implementation, Timeline behavior
- Settings ack behavior and Camera value validation
- Broad `App.tsx` or `renderer.rs` refactors

## Git workflow

- Suggested branch: `codex/001-backend-lifecycle`
- Preserve the dirty `vendor/kiss3d-toon` submodule.
- Use one logical commit, matching the imperative history style, e.g.
  `Make backend lifecycle transitions transactional`.
- Do not stage, commit, push, or open a PR unless the operator explicitly asks.

## Considered approaches

1. Add an unconditional `set_renderer_active(true)` to effect cleanup: rejected;
   an older cleanup could reactivate Native after a newer Canvas transition.
2. Fix only Frontend sequencing: rejected; the Rust Device Lost/reactivation
   interleaving would remain.
3. Adopt a generation-owned Frontend transition plus one Rust lifecycle store:
   selected because it closes both races while keeping resize/render ownership
   unchanged.

## Steps

### Step 1: Add Frontend transition characterization tests

Create `backendTransition.ts` as a UI-framework-independent controller. Inject
dependencies for deactivate, read/write Camera, mount/dispose Canvas, and report
errors. The controller must own a monotonically increasing generation/token;
only the current generation may mount, write Camera, or reactivate Native.

Before wiring it to React, add deferred-Promise tests for:

- normal Native→Canvas→Native with exactly one Canvas dispose and Camera write;
- exit after deactivate resolves but before Camera read resolves;
- exit after Camera read but before mount;
- Native deactivation rejection: Canvas must not mount;
- Canvas mount exception: current transition reactivates Native;
- stale cleanup from generation N cannot reactivate during generation N+1;
- controller disposal is idempotent.

Do not require jsdom or add React Testing Library. Keep the controller pure
enough for the existing Node Vitest environment.

**Verify**: `rtk npx vitest run src/viewport/backendTransition.test.ts` → all
new tests pass.

### Step 2: Replace the React effect with the tested controller

Instantiate the controller once per `ViewportHost` mount and route `mode`
changes through it. Native deactivation failure must surface as a diagnostic and
must not mount Canvas. Cleanup must dispose the controller even if no Canvas
handle exists. Keep `mountCanvasBackend`, the current Camera DTO, and the DOM
host contract unchanged.

Do not use the existing `safeInvoke` swallowing behavior for load-bearing
activation/deactivation calls. The controller needs rejected Promises so it can
restore state. Browser-only preview may retain a no-Tauri adapter, explicitly
selected by `"__TAURI_INTERNALS__" in window`, rather than treating any IPC
failure as expected browser mode.

**Verify**: `rtk npx tsc --noEmit` → no errors; focused Frontend test still
passes.

### Step 3: Unify Rust lifecycle mutations

Move the render permission into `RendererStatusStore` (renaming it to
`RendererLifecycleStore` is allowed if all call sites stay in scope). The store
must provide:

- `status()` for the wire snapshot;
- `is_active()` for the hot render-loop read;
- `set_active(active)` that rejects activation when unavailable;
- `mark_unavailable_once(reason)` that atomically makes availability and render
  permission false and returns the one-shot event snapshot.

An internal atomic fast-path is acceptable, but every mutation of it must occur
while holding the same lifecycle lock that guards `RendererStatus`. Remove the
separately managed `RendererActive` state. Route user activation, Device Lost,
SurfaceUnavailable, initial state, and the render-loop active check through the
single store.

Add deterministic tests that force these orders through store methods:

- deactivate → activate while available;
- unavailable → activate rejects and remains inactive;
- activate → unavailable ends unavailable/inactive;
- repeated unavailable emits once;
- no status snapshot can report unavailable while `is_active()` is true.

**Verify**: focused Rust command → all renderer-status tests pass.

### Step 4: Run focused GUI lifecycle evidence

Run a Tauri dev instance with the existing backend self-test:

```powershell
$env:VITE_BACKEND_SELF_TEST = "1"
$env:TAURI3D_LOG_VIEWPORT_RECT = "1"
rtk npm run tauri dev
```

Capture the settled Native→Canvas→Native result with `screenshot-ui`. Confirm:
Canvas appears only in Canvas mode, Native resumes, Camera does not jump, and no
inactive backend continues drawing. Run a second process with
`TAURI3D_FORCE_DEVICE_LOST=1` and confirm fallback remains one-shot and Native
cannot be reactivated in-process.

Clear the environment variables after the run.

**Verify**: logs contain no activation error on the normal cycle; Device Lost
produces one unavailable transition; both captures are retained outside tracked
source paths.

### Step 5: Run full gates and inspect scope

Run the shared baseline commands from `plans/README.md`.

**Verify**: all commands exit 0; `git diff --check` is clean; `git status` shows
only the five in-scope paths (plus plan status if updated) and the pre-existing
dirty vendor submodule.

## Test plan

- `backendTransition.test.ts`: seven cases listed in Step 1.
- `renderer_status.rs`: lifecycle invariants and activation/unavailable
  interleavings listed in Step 3.
- Preserve current surface reason tests and Device Lost self-test behavior.
- Do not mock away controller sequencing; deferred Promises must prove ordering.

## Done criteria

- [ ] Canvas cannot mount unless Native deactivation succeeded.
- [ ] Every current-generation cancellation/mount-failure path restores Native.
- [ ] A stale generation cannot reactivate or overwrite Camera.
- [ ] Rust has one lifecycle authority; `RendererActive` no longer exists.
- [ ] Unavailable status can never coexist with active render permission.
- [ ] Focused and full Frontend/Rust gates pass.
- [ ] Normal backend cycle and Device Lost GUI evidence pass.
- [ ] No out-of-scope or vendor file is modified.

## STOP conditions

- The fix requires dropping/recreating the parked Kiss3D renderer.
- The fix requires changing vendor code or surface/viewport resize ownership.
- A generation-safe controller cannot be tested without adding a browser test
  framework; report why before adding dependencies.
- Device Lost callback cannot call the lifecycle store safely from its thread.
- Any existing Native→Canvas→Native Camera continuity gate regresses.

## Maintenance notes

Future backend modes must enter through this controller/store pair. Reviewers
should reject direct writes to a second active flag or ad-hoc effect cleanup.
Playback behavior while Canvas is active remains a deferred finding and must not
be silently changed here.

