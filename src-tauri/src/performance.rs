use std::time::Duration;

use kiss3d::renderer::RenderTimings;

const MAX_PERFORMANCE_SAMPLE_FRAMES: usize = 1_000_000;

pub(crate) struct PerformanceSampler {
    sample_frames: usize,
    warmup_remaining: usize,
    frame_wall: Vec<Duration>,
    cpu_render: Vec<Duration>,
    gpu: Vec<Duration>,
    reported: bool,
}

impl PerformanceSampler {
    pub(crate) fn from_env() -> Option<Self> {
        let sample_frames = std::env::var("TAURI3D_PERF_SAMPLE_FRAMES")
            .ok()?
            .parse::<usize>()
            .ok()
            .and_then(validate_sample_frames)?;
        let (frame_wall, cpu_render, gpu) = allocate_sample_buffers(sample_frames)?;
        Some(Self {
            sample_frames,
            warmup_remaining: 60,
            frame_wall,
            cpu_render,
            gpu,
            reported: false,
        })
    }

    pub(crate) fn observe(&mut self, timings: &RenderTimings, target: Option<(u32, u32)>) {
        if self.reported || timings.frame_wall == Duration::ZERO {
            return;
        }
        if self.warmup_remaining > 0 {
            self.warmup_remaining -= 1;
            return;
        }
        self.frame_wall.push(timings.frame_wall);
        self.cpu_render.push(timings.total);
        if let Some(gpu) = timings.gpu_total() {
            self.gpu.push(gpu);
        }
        if self.frame_wall.len() < self.sample_frames {
            return;
        }
        self.reported = true;
        self.frame_wall.sort_unstable();
        self.cpu_render.sort_unstable();
        self.gpu.sort_unstable();
        let (target_width, target_height) = target.unwrap_or_default();
        let average_wall = self
            .frame_wall
            .iter()
            .map(Duration::as_secs_f64)
            .sum::<f64>()
            / self.frame_wall.len() as f64;
        let gpu_p95 = if self.gpu.is_empty() {
            "null".to_string()
        } else {
            format!("{:.3}", percentile_ms(&self.gpu, 0.95))
        };
        eprintln!(
            "[perf] {{\"backend\":\"native\",\"targetWidth\":{target_width},\"targetHeight\":{target_height},\"samples\":{},\"averageFps\":{:.3},\"frameWallP50Ms\":{:.3},\"frameWallP95Ms\":{:.3},\"frameWallP99Ms\":{:.3},\"cpuRenderP50Ms\":{:.3},\"cpuRenderP95Ms\":{:.3},\"cpuRenderP99Ms\":{:.3},\"gpuP95Ms\":{gpu_p95},\"gpuTiming\":\"{}\"}}",
            self.frame_wall.len(),
            1.0 / average_wall,
            percentile_ms(&self.frame_wall, 0.50),
            percentile_ms(&self.frame_wall, 0.95),
            percentile_ms(&self.frame_wall, 0.99),
            percentile_ms(&self.cpu_render, 0.50),
            percentile_ms(&self.cpu_render, 0.95),
            percentile_ms(&self.cpu_render, 0.99),
            if self.gpu.is_empty() {
                "unavailable"
            } else {
                "timestamp-query"
            },
        );
    }
}

fn allocate_sample_buffers(
    sample_frames: usize,
) -> Option<(Vec<Duration>, Vec<Duration>, Vec<Duration>)> {
    let mut frame_wall = Vec::new();
    frame_wall.try_reserve(sample_frames).ok()?;
    let mut cpu_render = Vec::new();
    cpu_render.try_reserve(sample_frames).ok()?;
    let mut gpu = Vec::new();
    gpu.try_reserve(sample_frames).ok()?;
    Some((frame_wall, cpu_render, gpu))
}

fn validate_sample_frames(value: usize) -> Option<usize> {
    (value > 0 && value <= MAX_PERFORMANCE_SAMPLE_FRAMES).then_some(value)
}

pub(crate) fn target_from_env() -> Option<(u32, u32)> {
    let value = std::env::var("TAURI3D_PERF_TARGET").ok()?;
    parse_target(&value)
}

fn parse_target(value: &str) -> Option<(u32, u32)> {
    let (width, height) = value.trim().split_once('x')?;
    let dimensions = (width.parse::<u32>().ok()?, height.parse::<u32>().ok()?);
    (dimensions.0 > 0 && dimensions.1 > 0 && dimensions.0 <= 16_384 && dimensions.1 <= 16_384)
        .then_some(dimensions)
}

/// Nearest-rank percentile over an already sorted, non-empty sample slice.
fn percentile_ms(samples: &[Duration], fraction: f64) -> f64 {
    let index = ((samples.len() as f64 * fraction).ceil() as usize).saturating_sub(1);
    samples[index.min(samples.len().saturating_sub(1))].as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_parser_accepts_only_bounded_physical_dimensions() {
        assert_eq!(parse_target("1920x1080"), Some((1920, 1080)));
        assert_eq!(parse_target("0x1080"), None);
        assert_eq!(parse_target("1920*1080"), None);
        assert_eq!(parse_target("20000x1080"), None);
    }

    #[test]
    fn sample_count_rejects_zero_and_unbounded_allocations() {
        assert_eq!(validate_sample_frames(1), Some(1));
        assert_eq!(
            validate_sample_frames(MAX_PERFORMANCE_SAMPLE_FRAMES),
            Some(MAX_PERFORMANCE_SAMPLE_FRAMES)
        );
        assert_eq!(validate_sample_frames(0), None);
        assert_eq!(
            validate_sample_frames(MAX_PERFORMANCE_SAMPLE_FRAMES + 1),
            None
        );
    }

    #[test]
    fn sample_buffers_reserve_without_panicking() {
        let (frame_wall, cpu_render, gpu) =
            allocate_sample_buffers(1).expect("small sample buffer allocation");
        assert!(frame_wall.capacity() >= 1);
        assert!(cpu_render.capacity() >= 1);
        assert!(gpu.capacity() >= 1);
    }

    #[test]
    fn percentile_uses_nearest_rank() {
        let samples = [10, 20, 30, 40].map(Duration::from_millis);
        assert_eq!(percentile_ms(&samples, 0.50), 20.0);
        assert_eq!(percentile_ms(&samples, 0.95), 40.0);
    }

    #[test]
    fn sampler_skips_initial_zero_frame_without_reporting() {
        let mut sampler = PerformanceSampler {
            sample_frames: 1,
            warmup_remaining: 0,
            frame_wall: Vec::new(),
            cpu_render: Vec::new(),
            gpu: Vec::new(),
            reported: false,
        };
        sampler.observe(&RenderTimings::default(), None);
        assert!(sampler.frame_wall.is_empty());
        assert!(!sampler.reported);
    }
}
