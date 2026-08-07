import { useEffect, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { selectSceneNode, useSceneProjection } from "../scene/adapters/sceneProjectionDataSource";
import type { SceneNodeSummary } from "../scene/core/projection";
import "./Outliner.css";

interface SceneNode extends SceneNodeSummary {
  children?: SceneNode[];
}

function toTree(nodes: SceneNodeSummary[]): SceneNode[] {
  const byId = new Map(nodes.map((node) => [node.id, { ...node } as SceneNode]));
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
  return roots;
}

function Node({ node, style, dragHandle }: NodeRendererProps<SceneNode>) {
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`outliner-row${node.isSelected ? " outliner-row--selected" : ""}`}
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
  const tree = toTree(projection.nodes);

  return (
    <div className="outliner-panel">
      <div className="outliner-panel__header">Outliner</div>
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
