const FRAME_COUNT = 24;
const FRAME_STEP = 10;

export function Timeline() {
  const ticks = Array.from({ length: FRAME_COUNT }, (_, i) => i * FRAME_STEP);

  return (
    <div className="panel timeline">
      <div className="panel__header">Timeline</div>
      <div className="timeline__ruler">
        {ticks.map((frame) => (
          <div className="timeline__tick" key={frame}>
            {frame}
          </div>
        ))}
      </div>
      <div className="timeline__track" />
    </div>
  );
}
