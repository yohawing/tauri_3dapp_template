import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import type { SceneNodeSummary } from "../scene/core/projection";
import { boundSearchQuery, MAX_SEARCH_QUERY_BYTES, normalizeSearchQuery } from "../searchQuery";
import "./Outliner.css";

/** Node id -> explicit expand/collapse state. Ids absent from the map fall
 * back to whatever `defaultOpen` a given `<Tree>`/toggle call was given.
 * Structurally identical to react-arborist's own (unexported) `OpenMap`. */
export type OutlinerOpenState = Record<string, boolean>;

/**
 * Mirrors react-arborist's internal open-state toggle reducer
 * (`state/open-slice.js`'s `VISIBILITY_TOGGLE`) so callers can track the same
 * expand/collapse semantics from outside the mounted `<Tree>` instance —
 * react-arborist only accepts open state as a one-time `initialOpenState`
 * seed, it has no fully-controlled "current open state" prop, so persisting
 * expand state across an unmount/remount means reproducing this toggle
 * ourselves rather than reading it back out of react-arborist.
 */
export function toggleOutlinerNode(
  openState: OutlinerOpenState,
  id: string,
  defaultOpen: boolean,
): OutlinerOpenState {
  const wasOpen = openState[id] ?? defaultOpen;
  return { ...openState, [id]: !wasOpen };
}

interface SceneNode extends SceneNodeSummary {
  children?: SceneNode[];
  uiHidden?: boolean;
  toggleVisibility?: (node: SceneNodeSummary) => void;
}

export const MAX_OUTLINER_QUERY_BYTES = MAX_SEARCH_QUERY_BYTES;
export const normalizeOutlinerQuery = normalizeSearchQuery;

const kindMeta = {
  scene: { tag: "ROOT", color: "#d7a448" },
  light: { tag: "LIGHT", color: "#f5c15d" },
  mesh: { tag: "MESH", color: "#8c79d8" },
  bone: { tag: "BONE", color: "#d89252" },
} as const;

// react-arborist positions virtual rows numerically, so this must match the
// --row-height design token rather than relying on the CSS height alone.
const OUTLINER_ROW_HEIGHT = 25;
const OUTLINER_INDENT = 19;

function VisibilityIcon({ hidden }: { hidden: boolean }) {
  return hidden ? (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 3 10 10M6.4 5.1A4.8 4.8 0 0 1 8 4.8c3.2 0 5.3 3.2 5.3 3.2a9 9 0 0 1-1.6 1.8M9.8 10.8A4.9 4.9 0 0 1 8 11.2C4.8 11.2 2.7 8 2.7 8a9 9 0 0 1 1.5-1.7" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.7 8S4.8 4.8 8 4.8 13.3 8 13.3 8 11.2 11.2 8 11.2 2.7 8 2.7 8Z" />
      <circle cx="8" cy="8" r="1.55" />
    </svg>
  );
}

function toTree(
  nodes: SceneNodeSummary[],
  toggleVisibility: (node: SceneNodeSummary) => void,
  query: string,
): SceneNode[] {
  const byId = new Map(nodes.map((node) => [node.id, { ...node } as SceneNode]));
  byId.forEach((node) => {
    node.uiHidden = !node.visible;
    // Reuse one callback for every row; large scenes should not allocate one
    // closure per node just to pass the id already present in the row data.
    node.toggleVisibility = toggleVisibility;
  });
  const roots: SceneNode[] = [];
  byId.forEach((node) => {
    if (node.parent === null) {
      roots.push(node);
      return;
    }
    const parent = byId.get(node.parent);
    if (parent) {
      (parent.children ??= []).push(node);
    }
  });

  const normalizedQuery = normalizeOutlinerQuery(query);
  if (normalizedQuery.length === 0) return roots;

  const filterBranch = (node: SceneNode): SceneNode | null => {
    const children = node.children
      ?.map(filterBranch)
      .filter((child): child is SceneNode => child !== null);
    if (!node.label.toLocaleLowerCase().includes(normalizedQuery) && !children?.length) {
      return null;
    }
    return { ...node, children };
  };

  return roots.map(filterBranch).filter((node): node is SceneNode => node !== null);
}

function Node({
  node,
  style,
  dragHandle,
  onSelect,
}: NodeRendererProps<SceneNode> & { onSelect: (nodeId: string) => void }) {
  const hidden = node.data.uiHidden === true;
  const meta = kindMeta[node.data.kind];
  const supportsVisibility = node.data.kind !== "bone";
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`outliner-row${node.isSelected ? " outliner-row--selected" : ""}${hidden ? " outliner-row--hidden" : ""}`}
      onClick={() => {
        node.select();
        onSelect(node.data.id);
      }}
    >
      {node.isInternal ? (
        <button
          type="button"
          className="outliner-row__caret"
          aria-label={`${node.isOpen ? "Collapse" : "Expand"} ${node.data.label}`}
          aria-expanded={node.isOpen}
          onClick={(event) => {
            event.stopPropagation();
            node.toggle();
          }}
        >
          {node.isOpen ? "▾" : "▸"}
        </button>
      ) : (
        <span className="outliner-row__caret" aria-hidden="true" />
      )}
      <span className="outliner-row__kind" style={{ backgroundColor: meta.color }} />
      <span className="outliner-row__label">{node.data.label}</span>
      <span className="outliner-row__tag">{meta.tag}</span>
      {supportsVisibility ? (
        <button
          type="button"
          className="outliner-row__visibility"
          aria-label={`${hidden ? "Show" : "Hide"} ${node.data.label}`}
          title="Toggle visibility"
          onClick={(event) => {
            event.stopPropagation();
            node.data.toggleVisibility?.(node.data);
          }}
        >
          <VisibilityIcon hidden={hidden} />
        </button>
      ) : (
        <span className="outliner-row__visibility outliner-row__visibility--placeholder" aria-hidden="true" />
      )}
    </div>
  );
}

// react-arborist's <Tree> requires explicit pixel width/height (it virtualizes
// rows via react-window internally), but this panel's size is whatever its
// host layout leaves it — so measure the body element and feed that in.
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

export interface OutlinerViewProps {
  /** Flat scene node list; parent/child structure is derived from `parent`. */
  nodes: SceneNodeSummary[];
  selectedNodeId: string | null;
  /** Controlled search query (already bound to `boundSearchQuery`). */
  query: string;
  uiScale?: number;
  onQueryChange: (query: string) => void;
  onSelect: (nodeId: string) => void;
  onToggleVisibility: (node: SceneNodeSummary) => void;
  /** Whether to render this panel's own internal "Outliner / Assets"
   * pseudo-tab row (the `outliner-panel__header` block below). Defaults to
   * `true` (unchanged behavior). A host whose real tab affordance already
   * lives one level up — e.g. dockview's own native tab strip, once a host
   * stops hiding `group.header` — should pass `false` here instead of
   * showing two stacked tab rows for the same panel. */
  showTabStrip?: boolean;
  /**
   * Node ids explicitly expanded/collapsed. Passed straight through to
   * react-arborist's `initialOpenState`, which only seeds the tree once per
   * mount (react-arborist has no fully-controlled "current open state"
   * prop) — so a caller that wants expand state to survive this component
   * unmounting (e.g. a dockview tab switch away and back) must persist this
   * map somewhere outside OutlinerView (a ref, a module-level singleton, a
   * store) and feed the latest value back in via this prop plus
   * `onOpenStateChange` below. Omit to let OutlinerView keep its own state
   * for as long as this instance stays mounted, and no longer — the
   * presentational default, matching how every other prop here works.
   */
  openState?: OutlinerOpenState;
  /** Expand state for a node absent from `openState`. Defaults to `false`
   * (collapsed) — react-arborist's own default is `true`, which is exactly
   * the bug this prop exists to override (a freshly mounted tree opening
   * every node). */
  defaultOpen?: boolean;
  /** Called after a node is expanded or collapsed with the resulting full
   * map, so a caller can persist it (see `openState` above). Fires whether
   * or not `openState` is controlled. */
  onOpenStateChange?: (openState: OutlinerOpenState) => void;
}

/**
 * Presentational scene tree. Takes scene node data and callbacks as props —
 * no data source, no Tauri IPC, no window event bus. Safe to import into any
 * host that can supply an `SceneNodeSummary[]` and wire the two callbacks.
 */
export function OutlinerView({
  nodes,
  selectedNodeId,
  query,
  uiScale = 1,
  onQueryChange,
  onSelect,
  onToggleVisibility,
  showTabStrip = true,
  openState,
  defaultOpen = false,
  onOpenStateChange,
}: OutlinerViewProps) {
  const { ref: bodyRef, size } = useElementSize<HTMLDivElement>();
  const tree = useMemo(
    () => toTree(nodes, onToggleVisibility, query),
    [nodes, onToggleVisibility, query],
  );

  // Uncontrolled fallback: only used while the caller doesn't pass its own
  // `openState`. Still lost on unmount, same as any other component-local
  // state — a caller that needs persistence across remounts supplies
  // `openState`/`onOpenStateChange` itself (see Outliner.tsx's container).
  const [uncontrolledOpenState, setUncontrolledOpenState] = useState<OutlinerOpenState>({});
  const isControlled = openState !== undefined;
  const effectiveOpenState = isControlled ? openState : uncontrolledOpenState;

  const handleToggle = useCallback(
    (id: string) => {
      const next = toggleOutlinerNode(effectiveOpenState, id, defaultOpen);
      if (!isControlled) setUncontrolledOpenState(next);
      onOpenStateChange?.(next);
    },
    [effectiveOpenState, defaultOpen, isControlled, onOpenStateChange],
  );

  return (
    <div className="outliner-panel">
      {showTabStrip && (
        <div className="outliner-panel__header">
          <button type="button" className="outliner-panel__tab outliner-panel__tab--active">Outliner</button>
          <button type="button" className="outliner-panel__tab" disabled>Assets</button>
          <span className="outliner-panel__actions" aria-hidden="true">＋ ⋯</span>
        </div>
      )}
      <label className="outliner-panel__search">
        <span className="sr-only">Search scene nodes</span>
        <input
          type="search"
          value={query}
          placeholder="Search…"
          aria-label="Search scene nodes"
          onChange={(event) => onQueryChange(boundSearchQuery(event.currentTarget.value))}
        />
      </label>
      <div className="outliner-panel__body" ref={bodyRef}>
        {size && size.width > 0 && size.height > 0 && (
          <Tree<SceneNode>
            data={tree}
            aria-label="Scene nodes"
            width={size.width}
            height={size.height}
            rowHeight={OUTLINER_ROW_HEIGHT * uiScale}
            indent={OUTLINER_INDENT * uiScale}
            openByDefault={defaultOpen}
            initialOpenState={effectiveOpenState}
            onToggle={handleToggle}
            disableEdit
            disableDrag
            selection={selectedNodeId ?? undefined}
          >
            {(props) => <Node {...props} onSelect={onSelect} />}
          </Tree>
        )}
      </div>
    </div>
  );
}
