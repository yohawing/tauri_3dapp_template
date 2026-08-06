interface PropertyRow {
  label: string;
  value: string;
}

// Placeholder property sheet — real values will be a projection of Native
// Rust canonical state (see plan section 9.1), not owned by React.
const PROPERTY_ROWS: PropertyRow[] = [
  { label: "Position X", value: "0.000" },
  { label: "Position Y", value: "1.200" },
  { label: "Position Z", value: "0.000" },
  { label: "Rotation Y", value: "45.0°" },
  { label: "Scale", value: "1.000" },
  { label: "Visible", value: "true" },
  { label: "Cast Shadow", value: "true" },
];

export function Inspector() {
  return (
    <div className="panel inspector">
      <div className="panel__header">Inspector</div>
      <div className="inspector__rows">
        {PROPERTY_ROWS.map((row) => (
          <div className="inspector__row" key={row.label}>
            <span className="inspector__label">{row.label}</span>
            <span className="inspector__value">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
