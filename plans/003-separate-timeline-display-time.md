# Plan 003: Keep Timeline display formatting out of canonical time

> **Executor instructions**: Follow every step and verification. Stop on the
> listed conditions. Update only plan 003's index row when complete.
>
> **Drift check (run first)**:
> `git diff --stat df95e79..HEAD -- src/panels/Timeline.tsx src/timeline/display.ts src/timeline/display.test.ts`
> Reconcile expected plan 002 changes before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-authoritative-playback-unavailable.md`
- **Category**: bug
- **Planned at**: commit `df95e79`, 2026-08-10

## Why this matters

The current default frame display rounds the playhead value itself to a 24fps
grid. Switching seconds→frames can therefore call `seekTo` and move Native
canonical playback by up to half a frame. Display formatting, explicit frame
stepping, and optional scrub snapping need separate policies.

## Current state

`src/panels/Timeline.tsx:50-57` combines clamping and presentation snapping:

```ts
function normalizeTimelineTime(time, timeEnd, displayMode) {
  const clamped = Math.min(timeEnd, Math.max(0, time));
  if (displayMode !== "frames") return clamped;
  return snapTimelineTimeToFrame(clamped);
}
```

`presentPlayhead` writes that value to `playheadTimeRef`, and
`toggleTimeDisplayMode` calls `seekTo` when rounding changes it. This contradicts
`docs/TIMELINE_PLAN.md:173-175`: frame rate, formatter, snap strategy, and
canonical time are separate; format/snap changes must not convert canonical
values.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused | `rtk npx vitest run src/timeline/display.test.ts src/timeline/playback.test.ts` | exit 0 |
| Typecheck | `rtk npx tsc --noEmit` | exit 0 |
| Frontend | `rtk npm run test` | exit 0 |
| Build | `rtk npm run build` | exit 0 |

## Scope

**In scope**:

- `src/panels/Timeline.tsx`
- `src/timeline/display.ts` (create)
- `src/timeline/display.test.ts` (create)

**Out of scope**:

- `src/timeline/playback.ts` and `src/timeline/playback.test.ts`; Native
  projection semantics are already covered there and do not need to change
- Configurable/rational project FPS UI; retain current 24fps presentation value
- Seconds/Ticks persistence or generic TemporalDocument work
- Scrub IPC coalescing
- Timeline visual redesign or range semantics
- Rust playback changes

## Git workflow

- Suggested branch: `codex/003-timeline-display-time`
- One commit: `Separate Timeline display from playback time`.
- Do not push; preserve unrelated and vendor changes.

## Considered approaches

1. Stop seeking only in the toggle handler: rejected because RAF presentation
   would still overwrite the canonical ref with rounded values.
2. Make frames display unrounded decimals: rejected because it removes useful
   presentation rather than separating concerns.
3. Keep one unsnapped canonical value and format/snap only at explicit call
   sites: selected.

## Steps

### Step 1: Extract pure time policies and tests

Create `display.ts` with explicit pure helpers:

- `clampTimelineTime(time, end)` — finite bounded canonical value;
- `snapTimelineTimeToFrame(time, fps)` — explicit editing action only;
- readout/tick formatting for `frames | seconds` without mutating input.

Add tests proving:

- formatting `1.02s` as frames does not return/modify a canonical replacement;
- toggle formatting is idempotent and produces no command payload;
- frame snap at 24fps is used only when explicitly requested;
- clamp handles start/end boundaries and rejects or normalizes non-finite input
  consistently with current behavior.

**Verify**: focused Vitest passes.

### Step 2: Preserve canonical time during presentation

Change `presentPlayhead` to clamp and store the unsnapped canonical time. Compute
rounded frame numbers only when assigning readout text. DOM playhead position
must use canonical seconds so Native projection remains smooth and exact.

`toggleTimeDisplayMode` must update only formatter state and repaint the readout;
it must never call `sendNative`, `seekTo`, or mutate the canonical time.

**Verify**: `rg -n -A12 "toggleTimeDisplayMode" src/panels/Timeline.tsx` shows no
Seek/dispatch call; typecheck and focused tests pass.

### Step 3: Make editing snap policy explicit

- Previous/Next Frame must change canonical time by exactly `1 / TIMELINE_FPS`
  and clamp.
- Pointer scrub may retain the current frames-mode snap, but it must request the
  snap explicitly rather than inheriting it from the display formatter.
- Native projected playback and display toggles must never snap/seek.
- Seconds mode scrub remains unsnapped.

Use a named `SeekPolicy` or explicit boolean/options object; do not infer edit
semantics inside a formatter.

**Verify**: focused tests include explicit scrub/frame-step policy cases; full
Frontend tests pass.

### Step 4: Run GUI playback evidence

Using an animated real asset, pause at a non-frame-aligned Native time, toggle
seconds→frames→seconds, and confirm the Native snapshot time is unchanged within
the existing measurement precision. Then verify Previous/Next Frame still moves
by `1/24s` and drag scrub remains usable. Use the existing Timeline playback
self-test where possible and `screenshot-ui` for the final visual state.

**Verify**: no Seek command is logged for display toggles; frame-step produces
one expected Seek; capture shows correct readout changes.

### Step 5: Run full gates

Run the shared baseline commands.

**Verify**: all pass and scope is clean.

## Test plan

- New pure display tests for canonical immutability, formatting, clamp, snap.
- Regression test: display toggle produces no Seek decision.
- Regression test: Native projected `1.02` remains canonical `1.02` in frame
  display while readout may show frame 24.
- Preserve existing playback projection and performance tests.

## Done criteria

- [ ] Display mode never mutates or seeks canonical time.
- [ ] Playhead position follows unsnapped Native seconds.
- [ ] Frame-step and optional frames-mode scrub use explicit snap policy.
- [ ] Current 24fps presentation remains; no generic FPS feature is added.
- [ ] Focused/full gates and GUI evidence pass.

## STOP conditions

- Plan 002 did not leave an explicit authoritative playback state.
- The real asset supplies a required frame rate that makes fixed 24fps actively
  incorrect; report this product decision instead of inventing an FPS source.
- Fix requires implementing Seconds/Ticks document conversion.
- Display toggle still emits any Native command after Step 2.

## Maintenance notes

If configurable rational FPS is added later, inject it into display/snap helpers;
do not store a converted canonical timeline value. Reviewers should scrutinize
any future formatter that returns a value later passed to Native commands.
