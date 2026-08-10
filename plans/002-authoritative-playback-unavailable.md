# Plan 002: Treat unavailable Native playback as authoritative

> **Executor instructions**: Follow every step and gate. Stop rather than
> improvising if a STOP condition occurs. Update only plan 002's status row when
> complete unless a reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat df95e79..HEAD -- src/panels/Timeline.tsx src/timeline/playback.ts src/timeline/playback.test.ts src/timeline/playbackState.ts src/timeline/playbackState.test.ts`
> Compare current excerpts after plan 001; behavioral mismatch is a STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-transactional-backend-lifecycle.md`
- **Category**: bug
- **Planned at**: commit `df95e79`, 2026-08-10

## Why this matters

Rust intentionally emits one `available=false` snapshot when an animated target
disappears, but the React listener discards it. The old clip, playing flag, RAF,
and command target therefore survive New Scene or opening an animation-free
asset. A plain `null` is not enough because this component also uses “no Native
snapshot” as the browser design-story preview mode; Tauri unavailable must be a
distinct, fail-closed state.

## Current state

`src/panels/Timeline.tsx:548-565` returns before accepting unavailable state:

```ts
if (!snapshot.available || snapshot.revision < latestRevision) return;
latestRevision = snapshot.revision;
nativePlaybackRef.current = snapshot;
setNativePlayback((current) => hasSamePlaybackMetadata(current, snapshot) ? current : snapshot);
setIsPlaying(snapshot.playing);
```

`src/panels/Timeline.tsx:634-654` starts a local preview timer whenever
`nativePlayback` is null, with no explicit browser/Tauri distinction.

Rust already guarantees the transition event in
`src-tauri/src/timeline_playback.rs:131-162` and tests available→unavailable at
lines 271-287. Native playback is canonical (`docs/IDEA.md:177-195`). Timeline
scope remains Play/Pause/Seek/Loop only (`TODO.md:16`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused | `rtk npx vitest run src/timeline/playback.test.ts src/timeline/playbackState.test.ts` | exit 0; all playback state tests pass |
| Typecheck | `rtk npx tsc --noEmit` | exit 0 |
| Frontend | `rtk npm run test` | exit 0 |
| Build | `rtk npm run build` | exit 0 |
| Rust regression | `rtk cargo test --locked --manifest-path src-tauri/Cargo.toml timeline_playback` | exit 0 |

## Scope

**In scope**:

- `src/panels/Timeline.tsx`
- `src/timeline/playback.ts`
- `src/timeline/playback.test.ts`
- `src/timeline/playbackState.ts` (create if extraction is used)
- `src/timeline/playbackState.test.ts` (create if extraction is used)

**Out of scope**:

- Rust playback command queue and scrub coalescing
- Fixture datasource removal
- Key/Clip editing, range editing, FPS/time-format changes
- Renderer active/inactive policy beyond consuming the authoritative snapshot
- CSS redesign

## Git workflow

- Suggested branch: `codex/002-playback-unavailable`
- One logical commit: `Handle unavailable Timeline playback state`.
- Preserve unrelated changes and dirty vendor state; do not push.

## Considered approaches

1. Remove only the `!snapshot.available` guard: rejected because the rest of the
   function assumes instance/clip metadata exists.
2. Set `nativePlayback` to null: rejected because null currently enables the
   browser preview clock in a Tauri process.
3. Add an explicit playback connection state and derive UI behavior: selected.

## Steps

### Step 1: Extract and characterize snapshot acceptance

Create a small pure state reducer/helper, either in `playback.ts` or
`playbackState.ts`, representing these states explicitly:

- `browser-preview` — selected only when no Tauri runtime exists;
- `native-loading` — Tauri runtime before the first authoritative response;
- `native-available` — contains the accepted snapshot;
- `native-unavailable` — contains the latest accepted revision and no target.

The reducer must reject lower revisions but accept `available=false` at an equal
or newer revision. Add tests for available→unavailable, stale unavailable,
unavailable→available, and repeated unavailable.

**Verify**: focused Vitest command → new reducer tests pass before React wiring.

### Step 2: Make the listener clear stale playback state

Wire the reducer into `Timeline`. On accepted unavailable state:

- set `nativePlaybackRef.current` and `nativePlayback` to null;
- set `isPlaying` and `loop` false;
- stop the Native projection RAF via the existing effect cleanup;
- clear the old command target;
- retain a deterministic playhead policy: reset to `0` for no target rather
  than showing the old clip time;
- do not enter the browser local preview timer in a Tauri process.

Keep latency measurement and sequence-gap accounting active for the transition
event. Revision checks must happen before state application, not by discarding
all unavailable snapshots.

**Verify**: focused Vitest and `npx tsc --noEmit` pass.

### Step 3: Fail closed in the production Timeline UI

Derive `controlsEnabled` from `browser-preview` or `native-available`. While
Tauri is loading/unavailable, Play, frame-step, Seek/scrub, Loop, and Space must
not mutate local playback state or dispatch commands. Show the existing empty
Timeline state; do not introduce a new product feature or fixture.

Browser-only component stories must retain the local preview timer and controls.
Do not make invoke failure silently select browser preview if
`__TAURI_INTERNALS__` is present; emit the existing diagnostic/error route.

**Verify**: build succeeds; `rg -n "nativePlayback \|\| !isPlaying" src/panels/Timeline.tsx`
no longer finds an unguarded Tauri local-preview condition.

### Step 4: Run Scene transition GUI evidence

Use a real animated glTF/FBX Scene and existing file self-test paths. Start
playback, then open/New an animation-free Scene. Prefer a non-interactive
`VITE_FILE_SELF_TEST_*` sequence; use minimal Computer Use only if no existing
self-test can trigger the transition, and report why.

Confirm the playhead resets/stops, controls do not send the old instance ID, and
loading another animated Scene reconnects playback. Capture the settled window
and retain logs outside tracked source paths.

**Verify**: no `timeline playback command rejected` log references the old
instance after unavailable; visual state is stopped and targetless.

### Step 5: Run full gates

Run the shared baseline from `plans/README.md`.

**Verify**: all pass; only in-scope files plus plan status and pre-existing vendor
dirty state appear in `git status`.

## Test plan

- Pure reducer/state tests: accepted revisions and all availability transitions.
- Preserve existing playback projection/instrumentation tests.
- Regression assertion: unavailable cannot retain a target or `playing=true`.
- Regression assertion: Tauri unavailable cannot run browser preview playback.
- GUI transition: animated→empty→animated.

## Done criteria

- [ ] `available=false` is accepted as authoritative when not stale.
- [ ] Old instance/clip target, RAF, playing, and looping state are cleared.
- [ ] Tauri unavailable does not run the browser preview clock.
- [ ] Browser design stories still support local preview.
- [ ] Focused/full Frontend and Rust regression gates pass.
- [ ] Animated→empty→animated GUI evidence passes.

## STOP conditions

- Plan 001 has not established reliable backend activity state.
- Rust does not emit available→unavailable for the reproduced Scene transition.
- Fixing the issue requires fixture datasource removal; report and defer to the
  separate finding rather than widening this plan.
- Existing browser design stories cannot be preserved without a new dependency.

## Maintenance notes

Do not use `null` to mean both browser preview and Native unavailable again.
Future Canvas playback policy should add an explicit state rather than reuse the
absence of a Native snapshot.

