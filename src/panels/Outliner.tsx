import { useCallback, useEffect, useRef, useState } from "react";
import {
  dispatchSceneCommand,
  selectSceneNode,
  useSceneProjection,
} from "../scene/adapters/sceneProjectionDataSource";
import type { SceneNodeSummary } from "../scene/core/projection";
import { OutlinerView, MAX_OUTLINER_QUERY_BYTES, normalizeOutlinerQuery } from "./OutlinerView";

export { MAX_OUTLINER_QUERY_BYTES, normalizeOutlinerQuery };

/**
 * Data-wired container: subscribes to the Native scene projection singleton
 * and renders the presentational `OutlinerView`. All scene-shape logic
 * (tree building, row rendering, search filtering) lives in OutlinerView —
 * this file's only job is wiring the app's live data source to it.
 */
export function Outliner() {
  const projection = useSceneProjection();
  const [query, setQuery] = useState("");
  const visibilityFailureRef = useRef<number | null>(null);

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

  const onSelect = useCallback((nodeId: string) => {
    selectSceneNode(nodeId);
  }, []);

  const onToggleVisibility = useCallback((node: SceneNodeSummary) => {
    dispatchSceneCommand({ type: "setVisibility", nodeId: node.id, visible: !node.visible });
  }, []);

  return (
    <OutlinerView
      nodes={projection.nodes}
      selectedNodeId={projection.selectedNodeId}
      query={query}
      onQueryChange={setQuery}
      onSelect={onSelect}
      onToggleVisibility={onToggleVisibility}
    />
  );
}
