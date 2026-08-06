interface OutlinerEntry {
  label: string;
  depth: number;
}

// Placeholder scene tree — Phase 0/1 has no real scene graph synced from Rust yet.
const OUTLINER_ENTRIES: OutlinerEntry[] = [
  { label: "Scene", depth: 0 },
  { label: "Camera", depth: 1 },
  { label: "Light_Key", depth: 1 },
  { label: "Light_Fill", depth: 1 },
  { label: "Mesh_Ground", depth: 1 },
  { label: "Character_Root", depth: 1 },
  { label: "Hips", depth: 2 },
  { label: "Spine", depth: 2 },
  { label: "Head", depth: 2 },
];

export function Outliner() {
  return (
    <div className="panel outliner">
      <div className="panel__header">Outliner</div>
      <ul className="outliner__tree">
        {OUTLINER_ENTRIES.map((entry) => (
          <li
            key={entry.label}
            className="outliner__item"
            style={{ paddingLeft: 10 + entry.depth * 14 }}
          >
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
