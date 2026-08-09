use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use crate::scene::{ResolvedAssetPath, Scene};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineProjection {
    pub revision: u64,
    pub clips: Vec<TimelineClipProjection>,
}

#[derive(Default)]
pub struct TimelineProjectionStore {
    projection: Mutex<TimelineProjection>,
}

impl TimelineProjectionStore {
    pub fn new(projection: TimelineProjection) -> Self {
        Self {
            projection: Mutex::new(projection),
        }
    }

    pub fn projection(&self) -> TimelineProjection {
        self.projection.lock().unwrap().clone()
    }

    pub fn replace(&self, mut projection: TimelineProjection) {
        let mut current = self.projection.lock().unwrap();
        projection.revision = current.revision.saturating_add(1);
        *current = projection;
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClipProjection {
    pub instance_id: String,
    pub clip_index: usize,
    pub label: String,
    pub duration: f32,
    pub channels: Vec<TimelineChannelProjection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineChannelProjection {
    pub id: String,
    pub node_index: usize,
    pub node_label: String,
    pub property: TimelineProperty,
    pub interpolation: TimelineInterpolation,
    pub key_times: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TimelineProperty {
    Translation,
    Rotation,
    Scale,
    MorphWeights,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TimelineInterpolation {
    Linear,
    Step,
    CubicSpline,
}

pub fn load_gltf_timeline(path: &Path, instance_id: &str) -> Result<TimelineProjection, String> {
    let (document, buffers, _) = gltf::import(path).map_err(|error| {
        format!(
            "animation metadata import failed at {}: {error}",
            path.display()
        )
    })?;
    let mut clips = Vec::new();

    for animation in document.animations() {
        let clip_index = animation.index();
        let label = non_empty(animation.name())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Animation {}", clip_index + 1));
        let mut duration = 0.0_f32;
        let mut channels = Vec::new();

        for (channel_index, channel) in animation.channels().enumerate() {
            let target = channel.target();
            let node = target.node();
            let node_index = node.index();
            let node_label = non_empty(node.name())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("Node {}", node_index + 1));
            let property = match target.property() {
                gltf::animation::Property::Translation => TimelineProperty::Translation,
                gltf::animation::Property::Rotation => TimelineProperty::Rotation,
                gltf::animation::Property::Scale => TimelineProperty::Scale,
                gltf::animation::Property::MorphTargetWeights => TimelineProperty::MorphWeights,
            };
            let interpolation = match channel.sampler().interpolation() {
                gltf::animation::Interpolation::Linear => TimelineInterpolation::Linear,
                gltf::animation::Interpolation::Step => TimelineInterpolation::Step,
                gltf::animation::Interpolation::CubicSpline => TimelineInterpolation::CubicSpline,
            };
            let reader = channel.reader(|buffer| Some(&buffers[buffer.index()]));
            let key_times: Vec<f32> = reader
                .read_inputs()
                .ok_or_else(|| {
                    format!("animation {clip_index} channel {channel_index} has no input accessor")
                })?
                .collect();
            if let Some(last) = key_times.last() {
                duration = duration.max(*last);
            }
            channels.push(TimelineChannelProjection {
                id: format!("{instance_id}:animation-{clip_index}:channel-{channel_index}"),
                node_index,
                node_label,
                property,
                interpolation,
                key_times,
            });
        }

        clips.push(TimelineClipProjection {
            instance_id: instance_id.to_string(),
            clip_index,
            label,
            duration,
            channels,
        });
    }

    Ok(TimelineProjection { revision: 1, clips })
}

pub fn load_scene_timeline(
    scene: &Scene,
    resolved_assets: &[ResolvedAssetPath],
) -> Result<TimelineProjection, String> {
    let mut projection = TimelineProjection::default();
    for instance in &scene.instances {
        let path = resolved_assets
            .iter()
            .find(|asset| asset.asset_id == instance.asset)
            .ok_or_else(|| {
                format!(
                    "animation metadata path missing for instance '{}' asset '{}'",
                    instance.id, instance.asset
                )
            })?;
        let instance_projection = load_gltf_timeline(&path.resolved_path, &instance.id)?;
        projection.clips.extend(instance_projection.clips);
    }
    projection.revision = 1;
    Ok(projection)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brainstem_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../glTF-Sample-Assets/Models/BrainStem/glTF/BrainStem.gltf")
    }

    #[test]
    fn brainstem_metadata_is_available_without_renderer_startup() {
        let path = brainstem_path();
        assert!(
            path.exists(),
            "BrainStem fixture missing at {}",
            path.display()
        );
        assert!(
            path.with_file_name("BrainStem0.bin").exists(),
            "BrainStem external buffer must remain adjacent"
        );
        let projection = load_gltf_timeline(&path, "brainstem").unwrap();
        assert_eq!(projection.clips.len(), 1);
        let clip = &projection.clips[0];
        assert_eq!(clip.label, "Animation 1");
        assert!((clip.duration - 34.88).abs() < 0.02, "{}", clip.duration);
        assert_eq!(clip.channels.len(), 57);
        assert_eq!(
            clip.channels
                .iter()
                .map(|channel| channel.key_times.len())
                .sum::<usize>(),
            74_613
        );
        assert!(clip.channels.iter().all(|channel| {
            channel.interpolation == TimelineInterpolation::Linear
                && channel.key_times.len() == 1_309
                && channel.node_label.starts_with("Node ")
        }));
        assert_eq!(
            clip.channels
                .iter()
                .filter(|channel| channel.property == TimelineProperty::Translation)
                .count(),
            19
        );
        assert_eq!(
            clip.channels
                .iter()
                .filter(|channel| channel.property == TimelineProperty::Rotation)
                .count(),
            19
        );
        assert_eq!(
            clip.channels
                .iter()
                .filter(|channel| channel.property == TimelineProperty::Scale)
                .count(),
            19
        );
    }

    #[test]
    fn projection_store_advances_revision_when_scene_is_replaced() {
        let store = TimelineProjectionStore::new(TimelineProjection {
            revision: 7,
            clips: Vec::new(),
        });
        store.replace(TimelineProjection::default());
        assert_eq!(store.projection().revision, 8);
    }
}
