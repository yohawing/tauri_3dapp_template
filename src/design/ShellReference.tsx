import "./shellReference.css";

type EyeIconProps = { hidden?: boolean };

function EyeIcon({ hidden = false }: EyeIconProps) {
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

const sceneRows = [
  { depth: 0, caret: "▾", color: "#d7a448", label: "Scene", tag: "ROOT" },
  { depth: 1, caret: "", color: "#73a7f3", label: "Camera", tag: "CAM" },
  { depth: 1, caret: "", color: "#f5c15d", label: "Key Light", tag: "LIGHT" },
  { depth: 1, caret: "▾", color: "#8c79d8", label: "Cube", tag: "MESH" },
  { depth: 2, caret: "", color: "#66b68f", label: "Cube.001", tag: "INST" },
  { depth: 2, caret: "", color: "#66b68f", label: "Cube.002", tag: "INST", hidden: true },
];

function VectorRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="ref-vector-row">
      <span>{label}</span>
      {values.map((value, index) => (
        <label key={`${label}-${index}`} data-axis={["x", "y", "z"][index]}>
          <span>{["X", "Y", "Z"][index]}</span>
          <input value={value} readOnly />
        </label>
      ))}
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ref-inspector-section">
      <header><span>▾</span>{title}</header>
      <div className="ref-inspector-section__body">{children}</div>
    </section>
  );
}

function TransportIcon({ kind }: { kind: "start" | "prev" | "play" | "next" | "end" }) {
  const labels = { start: "|◀", prev: "◀", play: "▶", next: "▶", end: "▶|" } as const;
  return <button type="button" aria-label={kind}>{labels[kind]}</button>;
}

function Timeline() {
  const tracks = ["Scene", "Camera", "Position", "Rotation", "Cube", "Position", "Rotation"];
  return (
    <div className="ref-timeline">
      <div className="ref-bottom-toolbar">
        <div className="ref-transport">
          <TransportIcon kind="start" /><TransportIcon kind="prev" /><TransportIcon kind="play" />
          <TransportIcon kind="next" /><TransportIcon kind="end" />
        </div>
        <span className="ref-frame">0029 / 0288</span>
        <span className="ref-separator" />
        <button className="is-active" type="button">Select</button><button type="button">Snap</button><button type="button">Ripple</button>
        <span className="ref-separator" /><button className="is-active" type="button">Range</button>
        <div className="ref-toolbar-time">00:01.21&nbsp;&nbsp; 24 fps</div>
      </div>
      <div className="ref-timeline-grid">
        <div className="ref-track-head"><span>TRACKS</span><span>＋ &nbsp;⋯</span></div>
        <div className="ref-ruler">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => <span key={n} style={{ left: `${n * 8.33}%` }}>{String(n).padStart(2, "0")}:00</span>)}
        </div>
        <div className="ref-track-list">
          {tracks.map((track, index) => (
            <div key={`${track}-${index}`} className={`ref-track-row ${index === 0 || index === 4 ? "is-group" : ""}`} style={{ paddingLeft: index === 0 || index === 4 ? 9 : index === 1 ? 24 : 39 }}>
              <span>{index === 0 || index === 4 ? "▾" : ""}</span><i style={{ background: index < 4 ? "#62a6e8" : "#9b78db" }} />{track}
              {index !== 0 && index !== 4 && <b>M&nbsp;&nbsp;L</b>}
            </div>
          ))}
        </div>
        <div className="ref-track-canvas">
          <div className="ref-range" />
          <div className="ref-playhead"><i /></div>
          {[7, 15, 24, 34, 43, 58, 69, 83].map((left, index) => <span className="ref-key" key={left} style={{ left: `${left}%`, top: `${16 + (index % 5) * 26}px` }} />)}
        </div>
        <div className="ref-track-foot">7 tracks</div>
        <div className="ref-zoom"><span>−</span><i><b /></i><span>＋</span></div>
      </div>
    </div>
  );
}

export function ShellReference() {
  return (
    <div className="ref-shell">
      <nav className="ref-menubar">
        <strong>Tauri3D</strong><button type="button">View</button><button type="button">Renderer</button>
        <div className="ref-renderer"><button className="is-active" type="button">Native</button><button type="button">Canvas</button></div>
      </nav>
      <main className="ref-layout">
        <aside className="ref-panel ref-outliner">
          <div className="ref-tabs"><button className="is-active" type="button">Outliner</button><button type="button">Assets</button><span>＋ &nbsp;⋯</span></div>
          <div className="ref-search"><span>⌕</span><input placeholder="Search scene…" /></div>
          <div className="ref-tree">
            {sceneRows.map((row) => (
              <div className="ref-tree-row" key={row.label} style={{ paddingLeft: 6 + row.depth * 14 }}>
                <span className="ref-caret">{row.caret}</span><i style={{ background: row.color }} /><span>{row.label}</span><small>{row.tag}</small>
                <button className="ref-eye" type="button"><EyeIcon hidden={row.hidden} /></button>
              </div>
            ))}
          </div>
          <div className="ref-panel-status">6 objects</div>
        </aside>
        <div className="ref-splitter ref-splitter--vertical" />
        <section className="ref-viewport">
          <div className="ref-viewport-badge">PERSPECTIVE</div><div className="ref-axis"><b>X</b><b>Y</b><b>Z</b></div>
        </section>
        <div className="ref-splitter ref-splitter--vertical" />
        <aside className="ref-panel ref-inspector">
          <div className="ref-tabs"><button className="is-active" type="button">Inspector</button><button type="button">Render</button></div>
          <div className="ref-selected"><i />Cube <small>MESH</small></div>
          <div className="ref-inspector-scroll">
            <InspectorSection title="Transform">
              <VectorRow label="Position" values={["0.000", "0.000", "0.000"]} />
              <VectorRow label="Rotation" values={["0.0°", "0.0°", "0.0°"]} />
              <VectorRow label="Scale" values={["1.000", "1.000", "1.000"]} />
            </InspectorSection>
            <InspectorSection title="Base Material">
              <div className="ref-property"><span>Base color</span><i className="ref-swatch" /><code>#6E8BC7</code></div>
              <div className="ref-property"><span>Metallic</span><i className="ref-slider"><b style={{ width: "14%" }} /></i><code>0.14</code></div>
              <div className="ref-property"><span>Roughness</span><i className="ref-slider"><b style={{ width: "52%" }} /></i><code>0.52</code></div>
            </InspectorSection>
            <InspectorSection title="Rendering">
              <div className="ref-property"><span>Shading</span><select defaultValue="Smooth"><option>Smooth</option></select></div>
              <div className="ref-property"><span>Cast shadows</span><input type="checkbox" checked readOnly /></div>
              <div className="ref-property"><span>Layer</span><select defaultValue="Default"><option>Default</option></select></div>
            </InspectorSection>
          </div>
          <div className="ref-panel-status">Object selected</div>
        </aside>
        <div className="ref-splitter ref-splitter--horizontal" />
        <section className="ref-bottom">
          <div className="ref-bottom-tabs"><button className="is-active" type="button">◆&nbsp; Timeline</button><button type="button">›_&nbsp; Console</button></div>
          <Timeline />
        </section>
      </main>
    </div>
  );
}
