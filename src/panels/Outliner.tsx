import { useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import {
  dispatchSceneCommand,
  selectSceneNode,
  useSceneProjection,
} from "../scene/adapters/sceneProjectionDataSource";
import type { SceneNodeSummary } from "../scene/core/projection";
import "./Outliner.css";

interface SceneNode extends SceneNodeSummary {
  children?: SceneNode[];
  uiHidden?: boolean;
  toggleVisibility?: () => void;
}

function toTree(
  nodes: SceneNodeSummary[],
  toggleVisibility: (nodeId: string) => void,
  query: string,
): SceneNode[] {
  const byId = new Map(nodes.map((node) => [node.id, { ...node } as SceneNode]));
  byId.forEach((node) => {
    node.uiHidden = !node.visible;
    node.toggleVisibility = () => toggleVisibility(node.id);
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

  const normalizedQuery = query.trim().toLocaleLowerCase();
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

function Node({ node, style, dragHandle }: NodeRendererProps<SceneNode>) {
  const hidden = node.data.uiHidden === true;
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`outliner-row${node.isSelected ? " outliner-row--selected" : ""}${hidden ? " outliner-row--hidden" : ""}`}
      onClick={() => {
        node.select();
        selectSceneNode(node.data.id);
      }}
    >
      <span
        className="outliner-row__caret"
        onClick={(e) => {
          e.stopPropagation();
          node.toggle();
        }}
      >
        {node.isInternal ? (node.isOpen ? "▾" : "▸") : ""}
      </span>
      <span className="outliner-row__label">{node.data.label}</span>
      <button
        type="button"
        className="outliner-row__visibility"
        aria-label={`${hidden ? "Show" : "Hide"} ${node.data.label}`}
        title="Toggle visibility"
        onClick={(event) => {
          event.stopPropagation();
          node.data.toggleVisibility?.();
        }}
      >
        {hidden ? "◌" : "◉"}
      </button>
    </div>
  );
}

// react-arborist's <Tree> requires explicit pixel width/height (it virtualizes
// rows via react-window internally), but this panel's size is whatever
// dockview's sashes leave it — so measure the body element and feed that in.
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

export function Outliner() {
  const { ref: bodyRef, size } = useElementSize<HTMLDivElement>();
  const projection = useSceneProjection();
  const [query, setQuery] = useState("");
  const visibilityFailureRef = useRef<number | null>(null);
  const tree = useMemo(
    () => toTree(
      projection.nodes,
      (nodeId) => {
        const node = projection.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return;
        dispatchSceneCommand({ type: "setVisibility", nodeId, visible: !node.visible });
      },
      query,
    ),
    [projection.nodes, query],
  );

  useEffect(() => {
    const failure = [...projection.commandResults]
      .reverse()
      .find((result) => result.property === "visibility" && !result.applied);
    if (!failure || visibilityFailureRef.current === failure.sequence) return;
    visibilityFailureRef.current = failure.sequence;
    const message = `Visibility rejected for ${failure.nodeId}: ${failure.error ?? "unsupported scene node"}`;
    console.warn(`[Outliner] ${message}`);
    window.dispatchEvent(
      new CustomEvent("tauri3d:diagnostic", {
        detail: { level: "warn", source: "outliner", message },
      }),
    );
  }, [projection.commandResults]);

  return (
    <div className="outliner-panel">
      <div className="outliner-panel__header">
        <button type="button" className="outliner-panel__tab outliner-panel__tab--active">Outliner</button>
        <button type="button" className="outliner-panel__tab" disabled>Assets</button>
        <span className="outliner-panel__actions" aria-hidden="true">＋ ⋯</span>
      </div>
      <label className="outliner-panel__search">
        <span className="sr-only">Search scene nodes</span>
        <input
          type="search"
          value={query}
          placeholder="Search…"
          aria-label="Search scene nodes"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="outliner-panel__body" ref={bodyRef}>
        {size && size.width > 0 && size.height > 0 && (
          <Tree<SceneNode>
            data={tree}
            width={size.width}
            height={size.height}
            rowHeight={22}
            indent={14}
            openByDefault
            disableEdit
            disableDrag
            selection={projection.selectedNodeId ?? undefined}
          >
            {Node}
          </Tree>
        )}
      </div>
    </div>
  );
}
