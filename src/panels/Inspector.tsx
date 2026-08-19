import { lazy, Suspense, useCallback, useState } from "react";
import { safeDiagnosticText } from "../console/contracts";
import { dispatchSceneCommand, useSceneProjection } from "../scene/adapters/sceneProjectionDataSource";
import type { SceneProjection } from "../scene/core/projection";
import { focusLazyPanelHost, LazyPanelBoundary } from "../components/LazyPanelBoundary";
import { InspectorView } from "./InspectorView";

function createLazyTweakpaneInspector() {
  return lazy(() =>
    import("./TweakpaneInspector").then(({ TweakpaneInspector: Inspector }) => ({ default: Inspector })),
  );
}

function InspectorLoading() {
  return <div className="inspector-loading" role="status">Loading inspector…</div>;
}

export function latestMaterialErrors(results: SceneProjection["commandResults"], nodeId: string): string | undefined {
  const latestByProperty = new Map<string, (typeof results)[number]>();
  for (const result of results) {
    if (
      result.nodeId === nodeId &&
      (result.property === "baseColor" || result.property === "metallic" || result.property === "roughness")
    ) {
      const previous = latestByProperty.get(result.property);
      if (!previous || result.sequence > previous.sequence) latestByProperty.set(result.property, result);
    }
  }
  const errors = [...latestByProperty.values()].flatMap((result) =>
    !result.applied && result.error ? [result.error] : [],
  );
  return errors.length > 0 ? errors.join(" · ") : undefined;
}

/**
 * Data-wired container: subscribes to the Native scene projection singleton
 * and renders the presentational `InspectorView` shell with a lazily-loaded
 * Tweakpane control surface as its content. `InspectorView` itself has no
 * data source or Tauri dependency — this file wires the app's live scene
 * data and command dispatch to it.
 */
export function Inspector() {
  const projection = useSceneProjection();
  const selected = projection.selected;
  const summary = projection.nodes.find((node) => node.id === projection.selectedNodeId);
  const materialError = selected ? latestMaterialErrors(projection.commandResults, selected.id) : undefined;
  const [tweakpaneGeneration, setTweakpaneGeneration] = useState(0);
  const [TweakpaneInspector, setTweakpaneInspector] = useState(createLazyTweakpaneInspector);
  const retryTweakpane = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    focusLazyPanelHost(event.currentTarget);
    setTweakpaneGeneration((generation) => generation + 1);
    setTweakpaneInspector(() => createLazyTweakpaneInspector());
  }, []);
  return (
    <InspectorView summary={summary}>
      {!selected || !summary ? null : (
        <LazyPanelBoundary
          key={`${selected.id}:${tweakpaneGeneration}`}
          source="inspector"
          diagnosticMessage={(error) => `Inspector controls unavailable: ${safeDiagnosticText(error)}`}
          onError={(error, info) => console.error("[Inspector] Tweakpane controls failed to load", error, info.componentStack)}
          fallback={(
            <div className="inspector-error" role="alert">
              <span>Inspector controls unavailable</span>
              <button type="button" className="inspector-error__retry" onClick={retryTweakpane}>
                Retry
              </button>
            </div>
          )}
        >
          <Suspense fallback={<InspectorLoading />}>
            <TweakpaneInspector
              key={selected.id}
              selected={selected}
              materialError={materialError}
              onCommand={dispatchSceneCommand}
            />
          </Suspense>
        </LazyPanelBoundary>
      )}
    </InspectorView>
  );
}
