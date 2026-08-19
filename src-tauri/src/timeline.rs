use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use crate::scene::{diagnostic_path, diagnostic_text, ResolvedAssetPath, Scene};

const MAX_TIMELINE_CLIPS: usize = 64;
const MAX_TIMELINE_CHANNELS: usize = 65_536;
const MAX_TIMELINE_KEY_TIMES: usize = 1_000_000;
const MAX_TIMELINE_OUTPUT_VALUES: usize = 1_000_000;
const MAX_TIMELINE_INSTANCE_ID_BYTES: usize = 1024;
const MAX_TIMELINE_LABEL_BYTES: usize = 4096;
const MAX_TIMELINE_DURATION_SECONDS: f32 = 86_400.0;

fn bounded_timeline_text(value: &str, field: &str) -> Result<String, String> {
    if value.len() > MAX_TIMELINE_LABEL_BYTES {
        return Err(format!(
            "timeline {field} exceeds the {MAX_TIMELINE_LABEL_BYTES}-byte limit"
        ));
    }
    Ok(value.to_owned())
}

fn validate_timeline_instance_id(instance_id: &str) -> Result<(), String> {
    if instance_id.len() > MAX_TIMELINE_INSTANCE_ID_BYTES {
        return Err(format!(
            "timeline instanceId exceeds the {MAX_TIMELINE_INSTANCE_ID_BYTES}-byte limit"
        ));
    }
    Ok(())
}

fn validate_timeline_duration(duration: f32, clip_index: usize) -> Result<(), String> {
    if !duration.is_finite() || !(0.0..=MAX_TIMELINE_DURATION_SECONDS).contains(&duration) {
        return Err(format!(
            "animation {clip_index} duration must be finite, non-negative, and at most {MAX_TIMELINE_DURATION_SECONDS} seconds"
        ));
    }
    Ok(())
}

fn validate_timeline_key_times(
    key_times: &[f32],
    clip_index: usize,
    channel_index: usize,
) -> Result<(), String> {
    let mut previous = None;
    for (key_index, &key_time) in key_times.iter().enumerate() {
        if !key_time.is_finite() {
            return Err(format!(
                "animation {clip_index} channel {channel_index} has non-finite key time at key {key_index}"
            ));
        }
        if key_time < 0.0 {
            return Err(format!(
                "animation {clip_index} channel {channel_index} key {key_index} time must be non-negative"
            ));
        }
        if previous.is_some_and(|previous| key_time < previous) {
            return Err(format!(
                "animation {clip_index} channel {channel_index} key times must be non-decreasing"
            ));
        }
        previous = Some(key_time);
    }
    Ok(())
}

#[derive(Default)]
struct TimelineBudget {
    clips: usize,
    channels: usize,
    key_times: usize,
    output_values: usize,
}

impl TimelineBudget {
    fn reserve_clip(&mut self) -> Result<(), String> {
        if self.clips >= MAX_TIMELINE_CLIPS {
            return Err(format!(
                "timeline metadata exceeds clip limit of {MAX_TIMELINE_CLIPS}"
            ));
        }
        self.clips += 1;
        Ok(())
    }

    fn reserve_channel(&mut self) -> Result<(), String> {
        if self.channels >= MAX_TIMELINE_CHANNELS {
            return Err(format!(
                "timeline metadata exceeds channel limit of {MAX_TIMELINE_CHANNELS}"
            ));
        }
        self.channels += 1;
        Ok(())
    }

    fn reserve_key_times(&mut self, count: usize) -> Result<(), String> {
        let total = self.key_times.checked_add(count).ok_or_else(|| {
            format!("timeline metadata exceeds key-time limit of {MAX_TIMELINE_KEY_TIMES}")
        })?;
        if total > MAX_TIMELINE_KEY_TIMES {
            return Err(format!(
                "timeline metadata exceeds key-time limit of {MAX_TIMELINE_KEY_TIMES}"
            ));
        }
        self.key_times = total;
        Ok(())
    }

    fn reserve_output_values(&mut self, count: usize) -> Result<(), String> {
        let total = self.output_values.checked_add(count).ok_or_else(|| {
            format!("timeline metadata exceeds output-value limit of {MAX_TIMELINE_OUTPUT_VALUES}")
        })?;
        if total > MAX_TIMELINE_OUTPUT_VALUES {
            return Err(format!(
                "timeline metadata exceeds output-value limit of {MAX_TIMELINE_OUTPUT_VALUES}"
            ));
        }
        self.output_values = total;
        Ok(())
    }

    fn reserve_projection(&mut self, projection: &TimelineProjection) -> Result<(), String> {
        for clip in &projection.clips {
            self.reserve_clip()?;
            for channel in &clip.channels {
                self.reserve_channel()?;
                self.reserve_key_times(channel.key_times.len())?;
            }
        }
        Ok(())
    }
}

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

#[allow(dead_code)]
pub fn load_gltf_timeline(path: &Path, instance_id: &str) -> Result<TimelineProjection, String> {
    validate_timeline_instance_id(instance_id)?;
    let mut budget = TimelineBudget::default();
    load_gltf_timeline_with_budget(path, instance_id, &mut budget)
}

fn load_gltf_timeline_with_budget(
    path: &Path,
    instance_id: &str,
    budget: &mut TimelineBudget,
) -> Result<TimelineProjection, String> {
    let gltf = gltf::Gltf::open(path).map_err(|error| {
        format!(
            "animation metadata import failed at {}: {}",
            diagnostic_path(path),
            diagnostic_text(&error.to_string())
        )
    })?;
    let base = path.parent().unwrap_or_else(|| Path::new("./"));
    let buffers = gltf::import_buffers(&gltf.document, Some(base), gltf.blob).map_err(|error| {
        format!(
            "animation metadata buffer import failed at {}: {}",
            diagnostic_path(path),
            diagnostic_text(&error.to_string())
        )
    })?;
    let document = gltf.document;
    let mut clips = Vec::new();

    for animation in document.animations() {
        budget.reserve_clip()?;
        let clip_index = animation.index();
        let label = match non_empty(animation.name()) {
            Some(label) => bounded_timeline_text(label, "clip label")?,
            None => format!("Animation {}", clip_index + 1),
        };
        let mut duration = 0.0_f32;
        let mut channels = Vec::new();

        for (channel_index, channel) in animation.channels().enumerate() {
            budget.reserve_channel()?;
            let target = channel.target();
            let node = target.node();
            let node_index = node.index();
            let node_label = match non_empty(node.name()) {
                Some(label) => bounded_timeline_text(label, "node label")?,
                None => format!("Node {}", node_index + 1),
            };
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
            let mut key_times = Vec::new();
            for key_time in reader.read_inputs().ok_or_else(|| {
                format!("animation {clip_index} channel {channel_index} has no input accessor")
            })? {
                budget.reserve_key_times(1)?;
                key_times.push(key_time);
            }
            validate_timeline_key_times(&key_times, clip_index, channel_index)?;
            let outputs = reader.read_outputs().ok_or_else(|| {
                format!("animation {clip_index} channel {channel_index} has no output accessor")
            })?;
            let mut output_count = 0usize;
            let mut non_finite_output = None;
            match outputs {
                gltf::animation::util::ReadOutputs::Translations(values)
                | gltf::animation::util::ReadOutputs::Scales(values) => {
                    for (output_index, value) in values.enumerate() {
                        budget.reserve_output_values(1)?;
                        output_count += 1;
                        if non_finite_output.is_none()
                            && !value.iter().all(|component| component.is_finite())
                        {
                            non_finite_output = Some(output_index);
                        }
                    }
                }
                gltf::animation::util::ReadOutputs::Rotations(values) => {
                    for (output_index, value) in values.into_f32().enumerate() {
                        budget.reserve_output_values(1)?;
                        output_count += 1;
                        if non_finite_output.is_none()
                            && !value.iter().all(|component| component.is_finite())
                        {
                            non_finite_output = Some(output_index);
                        }
                    }
                }
                gltf::animation::util::ReadOutputs::MorphTargetWeights(values) => {
                    for (output_index, value) in values.into_f32().enumerate() {
                        budget.reserve_output_values(1)?;
                        output_count += 1;
                        if non_finite_output.is_none() && !value.is_finite() {
                            non_finite_output = Some(output_index);
                        }
                    }
                }
            };
            if let Some(output_index) = non_finite_output {
                return Err(format!(
                    "animation {clip_index} channel {channel_index} has a non-finite output value at key {output_index}"
                ));
            }
            let components_per_key = if property == TimelineProperty::MorphWeights {
                node.mesh()
                    .and_then(|mesh| {
                        mesh.primitives()
                            .map(|primitive| primitive.morph_targets().len())
                            .max()
                    })
                    .filter(|count| *count > 0)
                    .ok_or_else(|| {
                        format!(
                            "animation {clip_index} channel {channel_index} targets a node without morph targets"
                        )
                    })?
            } else {
                1
            };
            kiss3d::loader::gltf::validate_animation_output_cardinality(
                key_times.len(),
                interpolation == TimelineInterpolation::CubicSpline,
                output_count,
                components_per_key,
            )
            .map_err(|error| {
                format!(
                    "animation {clip_index} channel {channel_index} has invalid output cardinality: {error}"
                )
            })?;
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
        validate_timeline_duration(duration, clip_index)?;
    }

    Ok(TimelineProjection { revision: 1, clips })
}

#[allow(dead_code)]
pub fn load_fbx_timeline(path: &Path, instance_id: &str) -> Result<TimelineProjection, String> {
    validate_timeline_instance_id(instance_id)?;
    let mut budget = TimelineBudget::default();
    load_fbx_timeline_with_budget(path, instance_id, &mut budget)
}

fn load_fbx_timeline_with_budget(
    path: &Path,
    instance_id: &str,
    budget: &mut TimelineBudget,
) -> Result<TimelineProjection, String> {
    let metadata = kiss3d::loader::fbx::animation_metadata(path).map_err(|error| {
        format!(
            "FBX animation metadata import failed at {}: {}",
            diagnostic_path(path),
            diagnostic_text(&error.to_string())
        )
    })?;
    let mut clips = Vec::new();
    for (clip_index, clip) in metadata.clips.into_iter().enumerate() {
        budget.reserve_clip()?;
        let clip_label = bounded_timeline_text(&clip.label, "clip label")?;
        let mut channels = Vec::new();
        for track in clip.tracks {
            let node_label = bounded_timeline_text(&track.node_label, "node label")?;
            validate_timeline_key_times(&track.key_times, clip_index, channels.len())?;
            for property in [
                TimelineProperty::Translation,
                TimelineProperty::Rotation,
                TimelineProperty::Scale,
            ] {
                budget.reserve_channel()?;
                budget.reserve_key_times(track.key_times.len())?;
                let channel_index = channels.len();
                channels.push(TimelineChannelProjection {
                    id: format!("{instance_id}:animation-{clip_index}:channel-{channel_index}"),
                    node_index: track.node_index,
                    node_label: node_label.clone(),
                    property,
                    interpolation: TimelineInterpolation::Linear,
                    key_times: track.key_times.clone(),
                });
            }
        }
        validate_timeline_duration(clip.duration, clip_index)?;
        if channels
            .iter()
            .filter_map(|channel| channel.key_times.last().copied())
            .any(|last| last > clip.duration)
        {
            return Err(format!(
                "animation {clip_index} key time exceeds clip duration"
            ));
        }
        clips.push(TimelineClipProjection {
            instance_id: instance_id.to_string(),
            clip_index,
            label: clip_label,
            duration: clip.duration,
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
    let mut budget = TimelineBudget::default();
    let mut assets_by_id = HashMap::with_capacity(scene.assets.len());
    for asset in &scene.assets {
        // Preserve the pre-cache `.find()` contract for malformed duplicate
        // inputs; validated Scenes are unique, but this boundary is public.
        assets_by_id.entry(asset.id.as_str()).or_insert(asset);
    }
    let mut paths_by_id = HashMap::with_capacity(resolved_assets.len());
    for asset in resolved_assets {
        paths_by_id.entry(asset.asset_id.as_str()).or_insert(asset);
    }
    // Parsing animation metadata is asset-scoped, while the resulting DTO is
    // instance-scoped. Cache one template per asset and rebind IDs for repeated
    // instances; cloned key data still passes through the aggregate budget.
    let mut templates = HashMap::<String, TimelineProjection>::new();
    for instance in &scene.instances {
        validate_timeline_instance_id(&instance.id)?;
        let asset = assets_by_id
            .get(instance.asset.as_str())
            .copied()
            .ok_or_else(|| {
                format!(
                    "animation metadata asset missing for instance '{}' asset '{}'",
                    diagnostic_text(&instance.id),
                    diagnostic_text(&instance.asset)
                )
            })?;
        let path = paths_by_id
            .get(instance.asset.as_str())
            .copied()
            .ok_or_else(|| {
                format!(
                    "animation metadata path missing for instance '{}' asset '{}'",
                    diagnostic_text(&instance.id),
                    diagnostic_text(&instance.asset)
                )
            })?;
        match asset.kind.as_str() {
            "gltf" => {
                let instance_projection = if let Some(template) = templates.get(&asset.id) {
                    budget.reserve_projection(template)?;
                    rebind_timeline_instance(template.clone(), &instance.id)
                } else {
                    let loaded = load_gltf_timeline_with_budget(
                        &path.resolved_path,
                        &instance.id,
                        &mut budget,
                    )?;
                    templates.insert(asset.id.clone(), loaded.clone());
                    loaded
                };
                projection.clips.extend(instance_projection.clips);
            }
            "fbx" => {
                let instance_projection = if let Some(template) = templates.get(&asset.id) {
                    budget.reserve_projection(template)?;
                    rebind_timeline_instance(template.clone(), &instance.id)
                } else {
                    let loaded = load_fbx_timeline_with_budget(
                        &path.resolved_path,
                        &instance.id,
                        &mut budget,
                    )?;
                    templates.insert(asset.id.clone(), loaded.clone());
                    loaded
                };
                projection.clips.extend(instance_projection.clips);
            }
            _ => {
                return Err(format!(
                    "unsupported asset kind '{}'",
                    diagnostic_text(&asset.kind)
                ))
            }
        }
    }
    projection.revision = 1;
    Ok(projection)
}

fn rebind_timeline_instance(
    mut projection: TimelineProjection,
    instance_id: &str,
) -> TimelineProjection {
    for clip in &mut projection.clips {
        clip.instance_id = instance_id.to_owned();
        for (channel_index, channel) in clip.channels.iter_mut().enumerate() {
            channel.id = format!(
                "{instance_id}:animation-{}:channel-{channel_index}",
                clip.clip_index
            );
        }
    }
    projection
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_fbx_scene_has_empty_timeline() {
        let fixture = br#"; FBX 7.4.0 project file
FBXHeaderExtension: { FBXHeaderVersion: 1003 FBXVersion: 7400 }
GlobalSettings: { Version: 1000 }
Documents: { Count: 1 Document: 1, "", "Scene" { RootNode: 0 } }
Definitions: { Version: 100 Count: 1 ObjectType: "Model" { Count: 1 } }
Objects: { Model: 100, "Model::Root", "Null" { Version: 232 } }
Connections: { C: "OO",100,0 }
"#;
        let fixture_path = std::env::temp_dir().join(format!(
            "tauri3d-static-timeline-{}-{}.fbx",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&fixture_path, fixture).unwrap();
        let scene = Scene {
            version: 1,
            name: Some("FBX".to_string()),
            assets: vec![crate::scene::SceneAsset {
                id: "prop".to_string(),
                kind: "fbx".to_string(),
                path: "prop.fbx".to_string(),
            }],
            instances: vec![crate::scene::SceneInstance {
                id: "prop-1".to_string(),
                asset: "prop".to_string(),
                transform: crate::scene::SceneTransform {
                    translation: [0.0, 0.0, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    scale: [1.0, 1.0, 1.0],
                },
                visible: true,
            }],
            camera: None,
        };
        let resolved = vec![ResolvedAssetPath {
            asset_id: "prop".to_string(),
            stored_path: Path::new("prop.fbx").to_path_buf(),
            resolved_path: fixture_path.clone(),
            kind: crate::scene::AssetPathKind::PortableRelative,
        }];
        let projection = load_scene_timeline(&scene, &resolved).unwrap();
        assert!(projection.clips.is_empty());
        std::fs::remove_file(fixture_path).unwrap();
    }

    #[test]
    fn gltf_metadata_is_available_without_renderer_startup() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-timeline-gltf-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.gltf");
        let binary_path = root.join("fixture.bin");
        let fixture = br#"{
  "asset": { "version": "2.0" },
  "scene": 0,
  "scenes": [{ "nodes": [0] }],
  "nodes": [{ "name": "Animated" }],
  "images": [{ "uri": "missing-image.png", "mimeType": "image/png" }],
  "buffers": [{ "uri": "fixture.bin", "byteLength": 32 }],
  "bufferViews": [
    { "buffer": 0, "byteOffset": 0, "byteLength": 8 },
    { "buffer": 0, "byteOffset": 8, "byteLength": 24 }
  ],
  "accessors": [
    {
      "bufferView": 0,
      "componentType": 5126,
      "count": 2,
      "type": "SCALAR",
      "min": [0.0],
      "max": [2.5]
    },
    {
      "bufferView": 1,
      "componentType": 5126,
      "count": 2,
      "type": "VEC3"
    }
  ],
  "animations": [{
    "name": "Fixture Clip",
    "samplers": [{ "input": 0, "output": 1, "interpolation": "LINEAR" }],
    "channels": [{
      "sampler": 0,
      "target": { "node": 0, "path": "translation" }
    }]
  }]
}"#;
        let mut binary = Vec::with_capacity(32);
        for value in [0.0_f32, 2.5, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
            binary.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(&path, fixture).unwrap();
        std::fs::write(&binary_path, binary).unwrap();

        let projection = load_gltf_timeline(&path, "fixture").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&binary_path).unwrap();
        std::fs::remove_dir(&root).unwrap();

        assert_eq!(projection.clips.len(), 1);
        let clip = &projection.clips[0];
        assert_eq!(clip.label, "Fixture Clip");
        assert!((clip.duration - 2.5).abs() < f32::EPSILON);
        assert_eq!(clip.channels.len(), 1);
        assert_eq!(clip.channels[0].node_label, "Animated");
        assert_eq!(clip.channels[0].property, TimelineProperty::Translation);
        assert_eq!(
            clip.channels[0].interpolation,
            TimelineInterpolation::Linear
        );
        assert_eq!(clip.channels[0].key_times, vec![0.0, 2.5]);
    }

    #[test]
    fn gltf_timeline_rejects_non_finite_key_times_before_ipc_serialization() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-timeline-gltf-nonfinite-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.gltf");
        let binary_path = root.join("fixture.bin");
        let fixture = br#"{
  "asset": { "version": "2.0" },
  "scene": 0,
  "scenes": [{ "nodes": [0] }],
  "nodes": [{ "name": "Animated" }],
  "buffers": [{ "uri": "fixture.bin", "byteLength": 32 }],
  "bufferViews": [
    { "buffer": 0, "byteOffset": 0, "byteLength": 8 },
    { "buffer": 0, "byteOffset": 8, "byteLength": 24 }
  ],
  "accessors": [
    { "bufferView": 0, "componentType": 5126, "count": 2, "type": "SCALAR" },
    { "bufferView": 1, "componentType": 5126, "count": 2, "type": "VEC3" }
  ],
  "animations": [{
    "samplers": [{ "input": 0, "output": 1 }],
    "channels": [{ "sampler": 0, "target": { "node": 0, "path": "translation" } }]
  }]
}"#;
        let mut binary = Vec::with_capacity(32);
        for value in [f32::NAN, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
            binary.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(&path, fixture).unwrap();
        std::fs::write(&binary_path, binary).unwrap();

        let error = load_gltf_timeline(&path, "fixture")
            .expect_err("non-finite key times must not cross the timeline IPC boundary");
        assert!(error.contains("non-finite key time"));

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&binary_path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn gltf_timeline_rejects_animation_output_cardinality_mismatch() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-timeline-gltf-cardinality-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.gltf");
        let binary_path = root.join("fixture.bin");
        let fixture = br#"{
  "asset": { "version": "2.0" },
  "scene": 0,
  "scenes": [{ "nodes": [0] }],
  "nodes": [{ "name": "Animated" }],
  "buffers": [{ "uri": "fixture.bin", "byteLength": 32 }],
  "bufferViews": [
    { "buffer": 0, "byteOffset": 0, "byteLength": 8 },
    { "buffer": 0, "byteOffset": 8, "byteLength": 24 }
  ],
  "accessors": [
    { "bufferView": 0, "componentType": 5126, "count": 2, "type": "SCALAR" },
    { "bufferView": 1, "componentType": 5126, "count": 1, "type": "VEC3" }
  ],
  "animations": [{
    "samplers": [{ "input": 0, "output": 1 }],
    "channels": [{ "sampler": 0, "target": { "node": 0, "path": "translation" } }]
  }]
}"#;
        let mut binary = Vec::with_capacity(32);
        for value in [0.0_f32, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
            binary.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(&path, fixture).unwrap();
        std::fs::write(&binary_path, binary).unwrap();

        let error = load_gltf_timeline(&path, "fixture")
            .expect_err("output count must match animation key count");
        assert!(error.contains("output cardinality"), "{error}");

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&binary_path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn gltf_timeline_rejects_non_finite_animation_outputs_before_runtime_load() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-timeline-gltf-output-nonfinite-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.gltf");
        let binary_path = root.join("fixture.bin");
        let fixture = br#"{
  "asset": { "version": "2.0" },
  "scene": 0,
  "scenes": [{ "nodes": [0] }],
  "nodes": [{ "name": "Animated" }],
  "buffers": [{ "uri": "fixture.bin", "byteLength": 32 }],
  "bufferViews": [
    { "buffer": 0, "byteOffset": 0, "byteLength": 8 },
    { "buffer": 0, "byteOffset": 8, "byteLength": 24 }
  ],
  "accessors": [
    { "bufferView": 0, "componentType": 5126, "count": 2, "type": "SCALAR" },
    { "bufferView": 1, "componentType": 5126, "count": 2, "type": "VEC3" }
  ],
  "animations": [{
    "samplers": [{ "input": 0, "output": 1 }],
    "channels": [{ "sampler": 0, "target": { "node": 0, "path": "translation" } }]
  }]
}"#;
        let mut binary = Vec::with_capacity(32);
        for value in [0.0_f32, 1.0, f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0] {
            binary.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(&path, fixture).unwrap();
        std::fs::write(&binary_path, binary).unwrap();

        let error = load_gltf_timeline(&path, "fixture")
            .expect_err("non-finite animation outputs must be rejected before runtime load");
        assert!(error.contains("non-finite output value"));

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&binary_path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    #[ignore = "requires an external BrainStem glTF fixture; set TAURI3D_BRAINSTEM_GLTF and run --ignored"]
    fn brainstem_metadata_is_available_without_renderer_startup() {
        let path = std::env::var_os("TAURI3D_BRAINSTEM_GLTF")
            .map(std::path::PathBuf::from)
            .expect("TAURI3D_BRAINSTEM_GLTF must point to BrainStem.gltf");
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

    #[test]
    fn timeline_budget_rejects_each_metadata_limit() {
        let mut budget = TimelineBudget {
            clips: MAX_TIMELINE_CLIPS,
            ..TimelineBudget::default()
        };
        assert!(budget.reserve_clip().is_err());

        let mut budget = TimelineBudget {
            channels: MAX_TIMELINE_CHANNELS,
            ..TimelineBudget::default()
        };
        assert!(budget.reserve_channel().is_err());

        let mut budget = TimelineBudget::default();
        budget.reserve_key_times(MAX_TIMELINE_KEY_TIMES).unwrap();
        assert!(budget.reserve_key_times(1).is_err());

        let mut budget = TimelineBudget::default();
        budget
            .reserve_output_values(MAX_TIMELINE_OUTPUT_VALUES)
            .unwrap();
        assert!(budget.reserve_output_values(1).is_err());
    }

    #[test]
    fn timeline_text_and_instance_id_limits_are_explicit() {
        assert!(
            bounded_timeline_text("x".repeat(MAX_TIMELINE_LABEL_BYTES).as_str(), "label").is_ok()
        );
        let error = bounded_timeline_text(&"x".repeat(MAX_TIMELINE_LABEL_BYTES + 1), "node label")
            .expect_err("metadata labels must be bounded");
        assert!(error.contains("node label"));
        assert!(validate_timeline_instance_id(&"x".repeat(MAX_TIMELINE_INSTANCE_ID_BYTES)).is_ok());
        assert!(
            validate_timeline_instance_id(&"x".repeat(MAX_TIMELINE_INSTANCE_ID_BYTES + 1)).is_err()
        );
    }

    #[test]
    fn timeline_duration_and_key_order_limits_match_frontend_contract() {
        assert!(validate_timeline_duration(MAX_TIMELINE_DURATION_SECONDS, 0).is_ok());
        assert!(validate_timeline_duration(MAX_TIMELINE_DURATION_SECONDS + 1.0, 0).is_err());
        assert!(validate_timeline_key_times(&[0.0, 1.0, 1.0], 0, 0).is_ok());
        assert!(validate_timeline_key_times(&[-0.1], 0, 0).is_err());
        assert!(validate_timeline_key_times(&[1.0, 0.5], 0, 0).is_err());
    }

    #[test]
    fn cached_timeline_template_rebinds_instance_ids_and_keeps_budget_accounting() {
        let template = TimelineProjection {
            revision: 1,
            clips: vec![TimelineClipProjection {
                instance_id: "first".to_string(),
                clip_index: 2,
                label: "Walk".to_string(),
                duration: 1.0,
                channels: vec![TimelineChannelProjection {
                    id: "first:animation-2:channel-0".to_string(),
                    node_index: 3,
                    node_label: "Root".to_string(),
                    property: TimelineProperty::Translation,
                    interpolation: TimelineInterpolation::Linear,
                    key_times: vec![0.0, 1.0],
                }],
            }],
        };
        let rebound = rebind_timeline_instance(template.clone(), "second");
        assert_eq!(rebound.clips[0].instance_id, "second");
        assert_eq!(
            rebound.clips[0].channels[0].id,
            "second:animation-2:channel-0"
        );
        assert_eq!(rebound.clips[0].channels[0].key_times, vec![0.0, 1.0]);

        let mut budget = TimelineBudget {
            clips: MAX_TIMELINE_CLIPS - 1,
            channels: MAX_TIMELINE_CHANNELS - 1,
            key_times: MAX_TIMELINE_KEY_TIMES - 2,
            output_values: 0,
        };
        budget
            .reserve_projection(&template)
            .expect("one cached instance fits the remaining budget");
        assert!(budget.reserve_projection(&template).is_err());
    }
}
