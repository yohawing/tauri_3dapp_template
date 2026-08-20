import { useLayoutEffect, useMemo, useState } from "react";
import type { EditorAction } from "../actions/editorActions";
import { CheckboxInput, CompactNumberInput, CompactSelect, RangeInput } from "../components/controls/CompactControls";
import { RangeViewport, type RangeViewportValue } from "../components/controls/RangeViewport";
import { ScalarBar } from "../components/controls/ScalarBar";
import { ConsoleDrawer } from "../console/ConsoleDrawer";
import { createConsoleStore } from "../console/state";
import { Inspector } from "../panels/Inspector";
import { MenuBar } from "../panels/MenuBar";
import { Outliner } from "../panels/Outliner";
import { Timeline } from "../panels/Timeline";
import { DEFAULT_SETTINGS, type Settings } from "../settings/model";
import { SettingsModal } from "../settings/SettingsModal";
import { fixtureTimelineDataSource } from "../timeline/adapters/fixtureDataSource";
import { ViewportHost } from "../viewport/ViewportHost";
import "./shellComponents.css";

function makeActions(): readonly EditorAction[] {
  const noop = () => undefined;
  return [
    { id: "file.new", label: "New Scene", shortcut: { code: "KeyN", primary: true }, enabled: true, run: noop },
    { id: "file.open", label: "Open…", shortcut: { code: "KeyO", primary: true }, enabled: true, run: noop },
    { id: "file.import", label: "Import Asset…", enabled: true, run: noop },
    { id: "file.save", label: "Save", shortcut: { code: "KeyS", primary: true }, enabled: true, run: noop },
    { id: "file.saveAs", label: "Save As…", shortcut: { code: "KeyS", primary: true, shift: true }, enabled: false, run: noop },
    { id: "renderer.native", label: "Native wgpu", enabled: true, checked: true, run: noop },
    { id: "renderer.canvas", label: "Canvas fallback", enabled: true, checked: false, run: noop },
    { id: "view.inspector.toggle", label: "Inspector", enabled: true, checked: true, run: noop },
    { id: "view.console.toggle", label: "Console", enabled: true, checked: true, run: noop },
    { id: "view.settings.open", label: "Settings…", enabled: true, run: noop },
    { id: "view.layout.reset", label: "Reset Layout", enabled: true, run: noop },
  ];
}

function Story({
  id,
  title,
  note,
  className = "",
  children,
}: {
  id: string;
  title: string;
  note: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`component-story ${className}`}>
      <header className="component-story__header">
        <div><strong>{title}</strong><span>{note}</span></div>
        <code>production</code>
      </header>
      <div className="component-story__stage">{children}</div>
    </section>
  );
}

const storyLinks = [
  ["menu-bar", "MenuBar"],
  ["controls", "Controls"],
  ["outliner", "Outliner"],
  ["inspector", "Inspector"],
  ["viewport", "ViewportHost"],
  ["timeline", "Timeline"],
  ["console", "ConsoleDrawer"],
  ["settings", "SettingsModal"],
] as const;

export function ShellComponentsPage() {
  const actions = useMemo(makeActions, []);
  const [settings, setSettings] = useState<Settings>(() => ({
    ui: { ...DEFAULT_SETTINGS.ui },
    viewport: { ...DEFAULT_SETTINGS.viewport },
    console: { ...DEFAULT_SETTINGS.console },
  }));
  useLayoutEffect(() => {
    document.documentElement.style.fontSize = `${settings.ui.scale * 16}px`;
  }, [settings.ui.scale]);
  const [scalarPreview, setScalarPreview] = useState(0.62);
  const [rangePreview, setRangePreview] = useState<RangeViewportValue>({ start: 12, end: 62 });
  const [consoleStore] = useState(() => {
    const store = createConsoleStore({ capacity: 20 });
    store.appendMany([
      { timestamp: "2026-08-09T08:05:20.120Z", level: "info", source: "scene", message: "Scene projection connected" },
      { timestamp: "2026-08-09T08:05:20.331Z", level: "info", source: "viewport", message: "rect x=220 y=24 w=940 h=634" },
      { timestamp: "2026-08-09T08:05:21.004Z", level: "warn", source: "renderer", message: "Canvas fallback is available" },
      { timestamp: "2026-08-09T08:05:22.482Z", level: "error", source: "frontend", message: "Example error state for visual review" },
    ]);
    return store;
  });

  return (
    <main className="components-page">
      <aside className="components-page__nav">
        <div><strong>Tauri3D UI</strong><span>Production component catalog</span></div>
        <nav aria-label="Component stories">
          {storyLinks.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </nav>
      </aside>
      <div className="components-page__content">
        <header className="components-page__intro">
          <div><span className="components-page__eyebrow">ACTUAL COMPONENTS</span><h1>Shell component catalog</h1><p>本番コードを直接マウント。比較専用の複製コンポーネントは使用していません。</p></div>
        </header>

        <Story id="menu-bar" title="MenuBar" note="menus, renderer segmented control, disabled command" className="component-story--menubar">
          <MenuBar actions={actions} backendLabel="Native wgpu" documentLabel="Built-in Scene" isMac={false} />
        </Story>

        <Story id="controls" title="Compact controls" note="shared production range, checkbox, select, number and state variants" className="component-story--controls">
          <div className="controls-preview">
            <div className="controls-preview__item"><span>ScalarBar</span><ScalarBar aria-label="Material preview" value={scalarPreview} onChange={setScalarPreview} /><output>{scalarPreview.toFixed(2)}</output></div>
            <div className="controls-preview__item"><span>RangeViewport</span><RangeViewport aria-label="Zoom range preview" start={rangePreview.start} end={rangePreview.end} onChange={setRangePreview} /><output>{rangePreview.start.toFixed(0)}–{rangePreview.end.toFixed(0)}</output></div>
            <label className="controls-preview__item"><CheckboxInput defaultChecked /><span>Cast shadows</span></label>
            <label className="controls-preview__item"><span>Shading</span><CompactSelect defaultValue="Smooth"><option>Smooth</option><option>Flat</option></CompactSelect></label>
            <label className="controls-preview__item"><span>Range</span><CompactNumberInput value={2} readOnly /><span>–</span><CompactNumberInput value={9.5} readOnly /></label>
            <div className="controls-preview__item"><span>Regular range</span><RangeInput aria-label="Disabled preview" value={35} disabled readOnly /><CheckboxInput disabled /></div>
          </div>
        </Story>

        <div className="components-page__panel-grid">
          <Story id="outliner" title="Outliner" note="tree, selection, visibility, search" className="component-story--panel"><Outliner /></Story>
          <Story id="inspector" title="Inspector" note="transform, material, light, rendering" className="component-story--panel"><Inspector /></Story>
          <Story id="viewport" title="ViewportHost" note="native transparent hole and diagnostics" className="component-story--panel component-story--viewport"><ViewportHost mode="native" /></Story>
        </div>

        <Story id="timeline" title="Timeline" note="full transport, range, tracks, clips, keys" className="component-story--timeline"><Timeline dataSource={fixtureTimelineDataSource} variant="full" /></Story>
        <Story id="console" title="ConsoleDrawer" note="all levels, filters, search, clipboard, auto-scroll" className="component-story--console"><ConsoleDrawer store={consoleStore} /></Story>
        <Story id="settings" title="SettingsModal" note="dialog, checkbox, select, close action" className="component-story--modal"><SettingsModal open settings={settings} onChange={setSettings} onClose={() => undefined} /></Story>
      </div>
    </main>
  );
}
