import { useEffect, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import "./Outliner.css";

interface SceneNode {
  id: string;
  name: string;
  children?: SceneNode[];
}

// Placeholder scene tree mirroring what the app actually renders today (see
// viewport/canvasBackend.ts): a single cube mesh, a directional light and a
// camera. The cube lives under a "Geometry" group so expand/collapse is
// actually exercised — Phase 0/1 has no real scene graph synced from Rust yet.
const SCENE_TREE: SceneNode[] = [
  {
    id: "scene",
    name: "Scene",
    children: [
      {
        id: "geometry",
        name: "Geometry",
        children: [{ id: "cube", name: "Cube" }],
      },
      { id: "light", name: "Directional Light" },
      { id: "camera", name: "Camera" },
    ],
  },
];

function Node({ node, style, dragHandle }: NodeRendererProps<SceneNode>) {
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`outliner-row${node.isSelected ? " outliner-row--selected" : ""}`}
      onClick={() => node.select()}
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
      <span className="outliner-row__label">{node.data.name}</span>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="outliner-panel">
      <div className="outliner-panel__header">Outliner</div>
      <div className="outliner-panel__body" ref={bodyRef}>
        {size && size.width > 0 && size.height > 0 && (
          <Tree<SceneNode>
            data={SCENE_TREE}
            width={size.width}
            height={size.height}
            rowHeight={22}
            indent={14}
            openByDefault
            disableEdit
            disableDrag
            selection={selectedId ?? undefined}
            onSelect={(nodes) => setSelectedId(nodes[0]?.id ?? null)}
          >
            {Node}
          </Tree>
        )}
      </div>
    </div>
  );
}
