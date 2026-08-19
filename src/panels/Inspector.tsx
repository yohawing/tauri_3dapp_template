import { lazy, Suspense, useCallback, useState } from "react";
import { safeDiagnosticText } from "../console/contracts";
import { useSceneProjection } from "../scene/adapters/sceneProjectionDataSource";
import type { SceneProjection } from "../scene/core/projection";
import { focusLazyPanelHost, LazyPanelBoundary } from "../components/LazyPanelBoundary";
import "./Inspector.css";

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
    <div className="inspector-panel">
      <div className="inspector-panel__header">
        <span className="inspector-panel__tab inspector-panel__tab--active">Inspector</span>
      </div>
      {!selected || !summary ? null : (
        <div className="inspector-selection">
          <span className="inspector-selection__label">{summary.label}</span>
          <span className="inspector-selection__kind">{summary.kind}</span>
        </div>
      )}
      <div className="inspector-panel__content">
        {!selected || !summary ? (
          <div className="inspector-empty">No scene node selected</div>
        ) : (
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
              />
            </Suspense>
          </LazyPanelBoundary>
        )}
      </div>
    </div>
  );
}
