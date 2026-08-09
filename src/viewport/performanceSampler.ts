export interface PerformanceSummary {
  backend: "canvas";
  targetWidth: number;
  targetHeight: number;
  samples: number;
  averageFps: number;
  frameWallP50Ms: number;
  frameWallP95Ms: number;
  frameWallP99Ms: number;
  cpuRenderP50Ms: number;
  cpuRenderP95Ms: number;
  cpuRenderP99Ms: number;
  gpuP95Ms: null;
  gpuTiming: "unavailable";
}

export function parsePerformanceTarget(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1 || width > 16384 || height > 16384) return null;
  return [width, height];
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class CanvasPerformanceSampler {
  private readonly frameWallMs: number[] = [];
  private readonly cpuRenderMs: number[] = [];
  private previousFrameAt: number | null = null;
  private seenFrames = 0;
  private reported = false;

  constructor(
    private readonly targetWidth: number,
    private readonly targetHeight: number,
    private readonly sampleFrames: number,
    private readonly warmupFrames = 60,
  ) {}

  observe(frameStartedAt: number, cpuRenderMs: number): PerformanceSummary | null {
    const wall = this.previousFrameAt === null ? null : frameStartedAt - this.previousFrameAt;
    this.previousFrameAt = frameStartedAt;
    this.seenFrames += 1;
    if (this.reported || this.seenFrames <= this.warmupFrames || wall === null) return null;

    this.frameWallMs.push(wall);
    this.cpuRenderMs.push(cpuRenderMs);
    if (this.frameWallMs.length < this.sampleFrames) return null;

    this.reported = true;
    const wallSorted = [...this.frameWallMs].sort((a, b) => a - b);
    const cpuSorted = [...this.cpuRenderMs].sort((a, b) => a - b);
    const averageWall = this.frameWallMs.reduce((sum, value) => sum + value, 0) / this.frameWallMs.length;
    return {
      backend: "canvas",
      targetWidth: this.targetWidth,
      targetHeight: this.targetHeight,
      samples: this.frameWallMs.length,
      averageFps: rounded(1000 / averageWall),
      frameWallP50Ms: rounded(percentile(wallSorted, 0.5)),
      frameWallP95Ms: rounded(percentile(wallSorted, 0.95)),
      frameWallP99Ms: rounded(percentile(wallSorted, 0.99)),
      cpuRenderP50Ms: rounded(percentile(cpuSorted, 0.5)),
      cpuRenderP95Ms: rounded(percentile(cpuSorted, 0.95)),
      cpuRenderP99Ms: rounded(percentile(cpuSorted, 0.99)),
      gpuP95Ms: null,
      gpuTiming: "unavailable",
    };
  }
}
