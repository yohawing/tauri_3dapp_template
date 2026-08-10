# Plan 004: Remove non-functional Inspector controls

> **Executor instructions**: Follow the steps and gates. Do not implement the
> missing rendering feature. Update only plan 004's status row when complete.
>
> **Drift check (run first)**:
> `git diff --stat df95e79..HEAD -- src/panels/Inspector.tsx src/panels/Inspector.css`
> If the controls gained a real Native command since planning, stop.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/003-separate-timeline-display-time.md`
- **Category**: tech-debt
- **Planned at**: commit `df95e79`, 2026-08-10

## Why this matters

Mesh Inspector exposes Shading, Cast shadows, and Layer bindings that have no
listeners and are initialized from hard-coded defaults. The Render tab also has
no selection handler or content. They are user-visible dead paths: changes look
accepted inside Tweakpane but never reach Native canonical state.

## Current state

- `src/panels/Inspector.tsx:123-127` creates hard-coded `rendering` values.
- `src/panels/Inspector.tsx:301-318` adds enabled bindings without `listen`.
- `src/panels/Inspector.tsx:344` adds them for every mesh.
- `src/panels/Inspector.tsx:396-399` renders an inert Render tab.
- `src/scene/core/projection.ts:69-87` has material, light, and visibility
  commands only; no rendering-property contract exists.

Current PoC scope explicitly avoids expanding unrelated features. Native is the
canonical source (`docs/IDEA.md:177-195`), so keeping local-only mutable UI is
not an acceptable placeholder.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Dead-path scan | `rg -n "addRenderingFolder|model\.rendering|>Render<|Shading|Layer" src/panels/Inspector.tsx` | no matches for removed production controls |
| Typecheck | `rtk npx tsc --noEmit` | exit 0 |
| Frontend | `rtk npm run test` | exit 0 |
| Build | `rtk npm run build` | exit 0 |

## Scope

**In scope**:

- `src/panels/Inspector.tsx`
- `src/panels/Inspector.css` only if selectors become unused

**Out of scope**:

- `src/scene/core/projection.ts` — reference the current command contract but do
  not edit it or add rendering command variants
- Implementing Shading, shadow, layer, or Render-tab features
- Native renderer/material/light behavior
- Replacing Tweakpane or redesigning Inspector
- Other component-catalog/design pages

## Git workflow

- Suggested branch: `codex/004-remove-dead-inspector-ui`
- One commit: `Remove non-functional Inspector controls`.
- Do not push; preserve dirty vendor state.

## Considered approaches

1. Wire controls to new Native commands: rejected as out of scope and lacking a
   Scene persistence contract.
2. Leave them enabled with a “preview” label: rejected because they still imply
   mutable local state.
3. Remove them from production: selected. A disabled placeholder is acceptable
   only if the product owner explicitly requires visible future direction.

## Steps

### Step 1: Remove hard-coded rendering model and bindings

Remove `PaneModel.rendering`, its initialization, `addRenderingFolder`, and the
mesh call site. Remove any imports/types that become unused. Do not change the
working Transform, Material, Light, or visibility paths.

**Verify**: dead-path scan returns no matches; typecheck passes.

### Step 2: Remove the inert Render tab

Render only the active Inspector heading/tab. Preserve existing header height
and layout; remove CSS only when an exact selector is now unreferenced. Do not
invent a tab state or empty Render page.

**Verify**: `rg -n "aria-selected=\"false\">Render" src` returns no matches;
build passes.

### Step 3: Run GUI Inspector evidence

Open the built-in cube and a real imported mesh. Confirm working Material fields
still edit/ack correctly, the non-functional Rendering folder and Render tab are
absent, and the panel has no layout gap. Use `VITE_MATERIAL_SELF_TEST=1` where
possible and capture with `screenshot-ui`.

**Verify**: material self-test still reports applied values; capture shows only
functional Inspector UI.

### Step 4: Run full gates

Run the shared baseline commands.

**Verify**: all pass; no changes outside scope.

## Test plan

- No new behavioral test is required for deletion-only UI if the scan,
  TypeScript build, existing Frontend tests, material self-test, and screenshot
  all pass.
- If extraction makes a pure Pane-model builder test cheap, assert the model has
  only projection-backed sections; do not introduce a UI test dependency solely
  for this deletion.

## Done criteria

- [ ] No mutable Inspector control lacks a Native/projection command path.
- [ ] Rendering folder and inert Render tab are absent.
- [ ] Transform, Material, Light, and visibility behavior is unchanged.
- [ ] No orphan CSS/import/type remains.
- [ ] Build/tests and focused GUI evidence pass.

## STOP conditions

- A current caller or self-test depends on the Rendering folder or Render tab.
- A real Native rendering command/projection field now exists on the live HEAD.
- Removing the tab requires a broad Inspector redesign.
- Material/light behavior changes while performing the deletion.

## Maintenance notes

Rendering UI may return only after the Native projection, validation, command
ack, persistence policy, tests, and Canvas-disabled behavior are defined. A
Tweakpane binding alone is not an implementation.
