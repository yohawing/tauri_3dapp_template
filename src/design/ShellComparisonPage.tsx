import { useEffect, useRef, useState } from "react";
import "./shellComparison.css";

type CompareMode = "side" | "overlay";

function ScaledFrame({ title, src, opacity = 1 }: { title: string; src: string; opacity?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setScale(Math.min(host.clientWidth / 1440, host.clientHeight / 900));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="compare-frame" style={{ opacity }}>
      <header>{title}<span>1440 × 900</span></header>
      <div className="compare-frame__host" ref={hostRef}>
        <iframe
          title={title}
          src={src}
          style={{
            left: `calc(50% - ${720 * scale}px)`,
            top: `calc(50% - ${450 * scale}px)`,
            transform: `scale(${scale})`,
          }}
        />
      </div>
    </section>
  );
}

export function ShellComparisonPage() {
  const [mode, setMode] = useState<CompareMode>("side");
  const [opacity, setOpacity] = useState(0.5);
  return (
    <main className="compare-page">
      <header className="compare-toolbar">
        <div><strong>Tauri3D visual comparison</strong><span>Reference HTML ↔ implementation</span></div>
        <div className="compare-mode" role="group" aria-label="Comparison mode">
          <button className={mode === "side" ? "is-active" : ""} type="button" onClick={() => setMode("side")}>Side by side</button>
          <button className={mode === "overlay" ? "is-active" : ""} type="button" onClick={() => setMode("overlay")}>Overlay</button>
        </div>
        <label className={mode === "overlay" ? "" : "is-disabled"}>Implementation opacity<input type="range" min="0" max="1" step="0.05" value={opacity} disabled={mode !== "overlay"} onChange={(event) => setOpacity(Number(event.currentTarget.value))} /><output>{Math.round(opacity * 100)}%</output></label>
        <a className="compare-toolbar__catalog" href="/?shell=components">All components ↗</a>
      </header>
      <div className={`compare-stage compare-stage--${mode}`}>
        <ScaledFrame title="Reference" src="/?shell=reference" />
        <ScaledFrame title="Implementation" src="/?shell=implementation" opacity={mode === "overlay" ? opacity : 1} />
      </div>
    </main>
  );
}
