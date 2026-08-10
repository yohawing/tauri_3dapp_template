# Plan 005: Persist runtime instance visibility in Scene files

> **Executor instructions**: Follow every step and gate. Keep built-in nodes and
> bones non-persistent. Stop on any ambiguity rather than broadening the Scene
> model. Update only plan 005's status row when complete.
>
> **Drift check (run first)**:
> `git diff --stat df95e79..HEAD -- src-tauri/src/scene_file.rs src-tauri/src/renderer.rs src-tauri/src/lib.rs src/scene/adapters/sceneProjectionDataSource.ts`
> Compare all current-state excerpts before editing.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/004-remove-dead-inspector-controls.md`
- **Category**: bug
- **Planned at**: commit `df95e79`, 2026-08-10

## Why this matters

`SceneInstance.visible` is a persisted Scene field, but Outliner visibility
commands currently mutate only Kiss3D nodes. Save clones `SceneFileState`'s old
document, so hiding an imported instance is lost after Save/Open. This plan
keeps built-in cube/light/bones transient while applying a runtime instance
visibility edit to renderer and document as one event-loop transaction.

## Current state

- `src-tauri/src/scene.rs:43-48`: `SceneInstance` contains `visible: bool`.
- `src-tauri/src/renderer.rs:607-633`: `SetVisibility` mutates built-in nodes,
  bones, or an instance root.
- `src-tauri/src/scene_file.rs:54-95`: Save serializes only the stored document
  snapshot plus current Camera.
- `src-tauri/src/lib.rs:613-624`: command application records renderer result but
  never updates `SceneFileState`.

Relevant current loop:

```rust
let result = renderer.apply_scene_command(envelope.command);
projection_store.record_command_result(SceneCommandResult {
    applied: result.is_ok(),
    error: result.err(),
    // ...
});
```

Design constraints:

- Native Scene is canonical, React is projection (`docs/IDEA.md:177-195`).
- Scene remains a small PoC save/exchange format, not a generic engine IR
  (`TODO.md:14,54`).
- Local absolute asset paths and external binaries must not become tracked
  fixtures (`TODO.md:56`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust focused | `rtk cargo test --locked --manifest-path src-tauri/Cargo.toml scene_file` | exit 0; new visibility round-trip tests pass |
| Scene tests | `rtk cargo test --locked --manifest-path src-tauri/Cargo.toml scene` | exit 0 |
| Rust full | `rtk cargo test --locked --manifest-path src-tauri/Cargo.toml` | exit 0 |
| Frontend | `rtk npm run test` | exit 0 |
| Build | `rtk npm run build` | exit 0 |

## Suggested executor toolkit

- Use `rust-coverage-meaningful-tests` if available for transaction and
  round-trip invariants.
- Use `screenshot-ui` for Outliner/Viewport evidence.

## Scope

**In scope**:

- `src-tauri/src/scene_file.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/renderer.rs` only for an exact runtime-instance classification
  or visibility query needed by the transaction
- `src/scene/adapters/sceneProjectionDataSource.ts` only if extending the
  existing visibility self-test to target a runtime instance

**Out of scope**:

- Persisting built-in Scene root, built-in cube/light, individual bones,
  material/light edits, Timeline state, or editor settings
- `src-tauri/src/scene.rs` and the persisted Scene schema; `visible` already
  exists and this plan must not change the file format
- Adding components, an asset database, dirty-document UI, Undo/Redo
- Atomic file replacement (a separate deferred finding)
- Vendor loader/renderer changes

## Git workflow

- Suggested branch: `codex/005-persist-instance-visibility`
- One commit: `Persist Scene instance visibility changes`.
- Do not push; preserve the dirty vendor submodule.

## Considered approaches

1. Read renderer visibility during Save: rejected because it makes persistence
   scrape runtime handles and cannot distinguish transient bones/built-ins well.
2. Update the document after every successful command without classifying the
   node: rejected because built-in/bone visibility is intentionally transient.
3. Classify runtime instance IDs and update renderer/document transactionally on
   the event-loop thread: selected.

## Steps

### Step 1: Add SceneFileState mutation and round-trip tests

Add a narrow method that updates one existing `SceneInstance.visible` and
increments the Scene file revision. It must distinguish:

- `Updated { previous }` for a document-backed instance;
- `NotPersistent` for no document or a missing instance, without mutation.

Do not accept arbitrary new IDs or create instances. Add tests for:

- true→false mutation of an existing instance;
- missing ID leaves document and revision unchanged;
- Save after mutation and reload preserves `visible=false`;
- failed/missing mutation cannot alter path, Camera, assets, or other instances.

Use existing `temp_path`, `Scene::empty`, `SceneAsset`, and `SceneInstance` test
patterns in `scene_file.rs:410+`; do not track a real asset fixture.

**Verify**: focused `scene_file` tests pass.

### Step 2: Classify persistent runtime instances before mutation

Provide a narrow `Renderer::is_runtime_instance(node_id)` or equivalent query
that returns true only for top-level document instances, not bones, Scene root,
key light, or built-in cube. Do not expose Kiss3D handles or add a generic node
type system.

**Verify**: add/extend a renderer unit test using existing runtime projection
fixtures to prove instance IDs classify true and bone/built-in IDs false; focused
Rust tests pass.

### Step 3: Apply visibility as one event-loop transaction

In the command loop, inspect `SetVisibility` before moving the command. For a
persistent runtime instance:

1. mutate `SceneFileState` and retain the previous value;
2. apply the renderer command;
3. if the renderer unexpectedly rejects, roll the document back to the previous
   value and record the command as rejected;
4. publish projection/ack only after the final result is known.

For built-in/bone targets, keep the current renderer-only path. If renderer says
an ID is a runtime instance but the document has no matching instance, reject
before mutating renderer and emit a specific consistency error; do not silently
treat it as transient.

Because Scene replacement and command application both run on the Tauri event
loop, do not introduce another async task or cross-thread document mutation.

**Verify**: full Rust tests pass; a new testable helper, if extracted, proves
rollback/error classification without requiring a GPU renderer mock.

### Step 4: Extend focused visibility evidence

Prefer extending `VITE_VISIBILITY_SELF_TEST` with an explicit mode such as
`instance-hide` that selects the first document-backed instance from the Native
projection, hides it through the same `dispatch` path, and reports the ack. Do
not change the existing default cube hide/show sequence.

Run a real FBX or glTF vertical slice:

1. Import/Open the asset using existing self-test paths.
2. Hide the top-level runtime instance.
3. Save As.
4. Restart and Open the saved Scene.
5. Confirm Outliner `visible=false` and Native mesh remains hidden.

Use local absolute paths and screenshots outside tracked source. Use minimal
Computer Use only if the self-test cannot complete one operation, and report the
reason.

**Verify**: Console shows an applied visibility ack before Save; the saved JSON
contains `visible: false` for the intended instance; reopened projection and
Viewport agree.

### Step 5: Run full gates and scope review

Run the shared baseline commands.

**Verify**: all pass; `git diff --check` clean; no vendor or out-of-scope changes.

## Test plan

- `SceneFileState` mutation: success, missing ID, revision preservation.
- Save/Open round-trip with `visible=false` and no real binary fixture.
- Runtime-instance classification excludes built-ins and bones.
- Transaction rollback/error behavior if renderer rejects after document change.
- Existing optimistic Frontend visibility tests remain green.
- Real asset non-interactive/GUI round-trip evidence.

## Done criteria

- [ ] Hiding a document-backed runtime instance updates renderer and Scene state.
- [ ] Save/Open preserves the changed visibility.
- [ ] Built-in nodes and bones remain non-persistent.
- [ ] Renderer/document mismatch rejects without silent divergence.
- [ ] No generic Scene/component/Undo architecture is introduced.
- [ ] Focused/full tests and real-asset GUI evidence pass.

## STOP conditions

- Runtime instance IDs do not map one-to-one to `Scene.instances` IDs.
- Persisting visibility requires vendor runtime-handle inspection or modification.
- Scene replacement can race command application off the event-loop thread.
- The only workable solution persists bone or built-in visibility implicitly.
- Existing real-asset Save/Open atomicity or Camera persistence regresses.

## Maintenance notes

Future persistent Scene commands should use the same explicit classification and
transaction pattern; do not scrape renderer state at Save time. Atomic disk
replacement and persistence of material/light edits remain separate decisions.
