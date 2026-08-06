import "./Timeline.css";

const FRAME_COUNT = 24;
const FRAME_STEP = 10;

export function Timeline() {
  const ticks = Array.from({ length: FRAME_COUNT }, (_, i) => i * FRAME_STEP);

  return (
    <div className="timeline-panel">
      <div className="timeline-panel__header">Timeline</div>
      <div className="timeline-panel__ruler">
        {ticks.map((frame) => (
          <div className="timeline-panel__tick" key={frame}>
            {frame}
          </div>
        ))}
      </div>
      <div className="timeline-panel__track" />
    </div>
  );
}
