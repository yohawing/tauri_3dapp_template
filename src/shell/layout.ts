import type { DockviewApi } from "dockview-react";
import type { ViewportMode } from "../viewport/ViewportHost";

/**
 * Builds the default DCC-style dock layout:
 *
 *   ┌────────────┬──────────────────┬────────────┐
 *   │ Outliner   │  Viewport        │ Inspector  │
 *   ├────────────┴──────────────────┴────────────┤
 *   │ Timeline                                   │
 *   └─────────────────────────────────────────────┘
 *
 * Order matters: viewport is added first (fills everything), then timeline
 * splits the *whole* area below it (full-width bottom row), then outliner /
 * inspector split only viewport's row (left/right), leaving the timeline row
 * untouched. Reversing the order would nest the split differently and shrink
 * the timeline to the center column's width instead of the full width.
 */
export function buildDefaultLayout(api: DockviewApi, mode: ViewportMode): void {
  api.clear();

  // `title` is still passed on every panel even though dockview's tab bar
  // (the only thing that ever rendered it) is hidden — see the
  // `onDidAddGroup` wiring in App.tsx's onReady. It's harmless to keep, shows
  // up in `api.toJSON()` / layout serialization, and costs nothing to leave
  // in if tabs are ever re-enabled later.
  api.addPanel({
    id: "viewport",
    component: "viewport",
    title: "Viewport",
    params: { mode },
  });

  api.addPanel({
    id: "timeline",
    component: "timeline",
    title: "Timeline",
    position: { direction: "below", referencePanel: "viewport" },
    initialHeight: 240,
  });

  api.addPanel({
    id: "outliner",
    component: "outliner",
    title: "Outliner",
    position: { direction: "left", referencePanel: "viewport" },
    initialWidth: 220,
  });

  api.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: { direction: "right", referencePanel: "viewport" },
    initialWidth: 280,
  });
}
