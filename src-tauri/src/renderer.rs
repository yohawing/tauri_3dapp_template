use std::collections::HashMap;
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::time::Instant;

use kiss3d::color::Color;
use kiss3d::prelude::{
    AnimationPlayer, CanvasSetup, Light, NumSamples, OrbitCamera3d, Quat, RenderViewport,
    SceneNode3d, Vec3, Window, BLACK, ORANGE,
};

use crate::performance::{target_from_env, PerformanceSampler};
use crate::protocol::{CameraState, ViewportRect};
use crate::scene::{ResolvedAssetPath, Scene, SceneInstance};
use crate::scene_projection::{
    SceneCommand, SceneMaterial, SceneNodeSummary, SceneProjection, SceneTransform,
    SelectedSceneNode,
};
use crate::timeline_playback::{TimelinePlaybackCommand, TimelinePlaybackSnapshot};

pub const SCENE_ID: &str = "scene";
pub const KEY_LIGHT_ID: &str = "key-light";
pub const CUBE_ID: &str = "cube";

const GRID_HALF_EXTENT: i32 = 10;
const AXIS_LENGTH: f32 = 2.5;
const GRID_MINOR_COLOR: Color = Color::new(0.16, 0.18, 0.22, 1.0);
const GRID_MAJOR_COLOR: Color = Color::new(0.28, 0.31, 0.37, 1.0);
const X_AXIS_COLOR: Color = Color::new(0.95, 0.20, 0.20, 1.0);
const Y_AXIS_COLOR: Color = Color::new(0.20, 0.85, 0.30, 1.0);
const Z_AXIS_COLOR: Color = Color::new(0.25, 0.45, 1.00, 1.0);

#[derive(Debug)]
pub enum RendererError {
    MissingResolvedAsset {
        asset_id: String,
        instance_id: String,
    },
    AssetLoad {
        instance_id: String,
        asset_id: String,
        path: String,
        message: String,
    },
    InvalidInstanceTransform {
        instance_id: String,
        message: String,
    },
}

impl fmt::Display for RendererError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingResolvedAsset {
                asset_id,
                instance_id,
            } => write!(
                formatter,
                "Scene instance '{instance_id}' references asset '{asset_id}' without a resolved path"
            ),
            Self::AssetLoad {
                instance_id,
                asset_id,
                path,
                message,
            } => write!(
                formatter,
                "failed to load Scene instance '{instance_id}' asset '{asset_id}' at {path}: {message}"
            ),
            Self::InvalidInstanceTransform {
                instance_id,
                message,
            } => write!(
                formatter,
                "invalid transform for Scene instance '{instance_id}': {message}"
            ),
        }
    }
}

impl std::error::Error for RendererError {}

struct RuntimeInstance {
    id: String,
    root: SceneNode3d,
    player: AnimationPlayer,
}

struct RuntimeScene {
    scene: SceneNode3d,
    key_light: SceneNode3d,
    cube: Option<SceneNode3d>,
    instances: Vec<RuntimeInstance>,
    scene_label: String,
    default_node_id: String,
}

/// Kiss3d scene hosted by the Tauri-owned native window.
///
/// Kiss3d deliberately keeps scene/window state single-threaded. The app owns
/// this value in thread-local storage on Tauri's event-loop thread; IPC only
/// shares the small camera/viewport DTOs.
pub struct Renderer {
    window: Window,
    scene: SceneNode3d,
    key_light: SceneNode3d,
    cube: Option<SceneNode3d>,
    instances: Vec<RuntimeInstance>,
    scene_label: String,
    default_node_id: String,
    camera: OrbitCamera3d,
    performance_target: Option<(u32, u32)>,
    performance_sampler: Option<PerformanceSampler>,
    animation_clock: Instant,
}

impl Renderer {
    pub fn new(window: tauri::WebviewWindow, size: (u32, u32)) -> Renderer {
        let width = size.0.max(1);
        let height = size.1.max(1);
        let setup = CanvasSetup {
            samples: NumSamples::One,
            ..CanvasSetup::default()
        };

        let mut kiss_window =
            pollster::block_on(Window::new_embedded(window, width, height, setup));
        kiss_window.set_background_color(BLACK);

        let mut scene = SceneNode3d::empty();
        let mut key_light = scene.add_light(Light::point(100.0));
        key_light.set_position(Vec3::new(2.5, 3.0, -2.0));
        let cube = scene.add_cube(0.5, 0.5, 0.5).set_color(ORANGE);
        let camera = OrbitCamera3d::new(Vec3::new(3.0, 1.5, -3.0), Vec3::ZERO);

        let performance_target = target_from_env();
        Renderer {
            window: kiss_window,
            scene,
            key_light,
            cube: Some(cube),
            instances: Vec::new(),
            scene_label: "Scene".to_string(),
            default_node_id: CUBE_ID.to_string(),
            camera,
            performance_target,
            performance_sampler: PerformanceSampler::from_env(),
            animation_clock: Instant::now(),
        }
    }

    pub fn new_from_scene(
        window: tauri::WebviewWindow,
        size: (u32, u32),
        scene_document: &Scene,
        resolved_assets: &[ResolvedAssetPath],
    ) -> Result<Renderer, RendererError> {
        let width = size.0.max(1);
        let height = size.1.max(1);
        let setup = CanvasSetup {
            samples: NumSamples::One,
            ..CanvasSetup::default()
        };

        let mut kiss_window =
            pollster::block_on(Window::new_embedded(window, width, height, setup));
        kiss_window.set_background_color(BLACK);

        let runtime = build_runtime_scene(scene_document, resolved_assets)?;

        let performance_target = target_from_env();
        Ok(Renderer {
            window: kiss_window,
            scene: runtime.scene,
            key_light: runtime.key_light,
            cube: runtime.cube,
            instances: runtime.instances,
            scene_label: runtime.scene_label,
            default_node_id: runtime.default_node_id,
            camera: OrbitCamera3d::new(Vec3::new(3.0, 1.5, -3.0), Vec3::ZERO),
            performance_target,
            performance_sampler: PerformanceSampler::from_env(),
            animation_clock: Instant::now(),
        })
    }

    /// Build a replacement scene completely before swapping it into the live
    /// renderer, so a failed File > Open leaves the current scene intact.
    pub fn replace_with_scene(
        &mut self,
        scene_document: &Scene,
        resolved_assets: &[ResolvedAssetPath],
    ) -> Result<(), RendererError> {
        let runtime = build_runtime_scene(scene_document, resolved_assets)?;
        self.scene = runtime.scene;
        self.key_light = runtime.key_light;
        self.cube = runtime.cube;
        self.instances = runtime.instances;
        self.scene_label = runtime.scene_label;
        self.default_node_id = runtime.default_node_id;
        self.animation_clock = Instant::now();
        Ok(())
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.window.canvas_mut().resize(width, height);
        }
    }

    pub fn set_camera_state(&mut self, state: CameraState) {
        let target = Vec3::from_array(state.target);
        let (sin_yaw, cos_yaw) = state.yaw.sin_cos();
        let (sin_pitch, cos_pitch) = state.pitch.sin_cos();
        let eye = target
            + state.distance * Vec3::new(cos_pitch * cos_yaw, sin_pitch, cos_pitch * sin_yaw);
        self.camera.look_at(eye, target);
    }

    pub fn set_viewport_rect(&mut self, rect: ViewportRect) {
        let viewport = self
            .performance_target
            .map(|(width, height)| RenderViewport::new(0, 0, width, height))
            .unwrap_or_else(|| viewport_rect_to_physical(rect));
        self.window.set_render_viewport(Some(viewport));
    }

    pub fn render(&mut self) {
        let now = Instant::now();
        let animation_dt = now
            .duration_since(self.animation_clock)
            .as_secs_f32()
            .min(0.1);
        self.animation_clock = now;
        for instance in &mut self.instances {
            instance.player.update(animation_dt);
        }
        if let Some(cube) = self.cube.as_mut() {
            cube.rotate(Quat::from_axis_angle(Vec3::Y, 0.006));
        }
        draw_reference_grid_and_axes(&mut self.window);
        let _ = pollster::block_on(self.window.render_3d(&mut self.scene, &mut self.camera));
        if let (Some(sampler), Some(timings)) = (
            self.performance_sampler.as_mut(),
            self.window.render_timings(),
        ) {
            sampler.observe(timings, self.performance_target);
        }
    }

    pub fn has_node(&self, node_id: &str) -> bool {
        node_id == SCENE_ID
            || node_id == KEY_LIGHT_ID
            || (node_id == CUBE_ID && self.cube.is_some())
            || self.instances.iter().any(|instance| instance.id == node_id)
    }

    pub fn default_node_id(&self) -> &str {
        &self.default_node_id
    }

    pub fn animation_clip_count(&self) -> usize {
        self.instances
            .iter()
            .map(|instance| instance.player.clip_count())
            .sum()
    }

    pub fn apply_timeline_playback_command(
        &mut self,
        command: TimelinePlaybackCommand,
    ) -> Result<(), String> {
        let (instance_id, clip_index) = command.target();
        let instance = self
            .instances
            .iter_mut()
            .find(|instance| instance.id == instance_id)
            .ok_or_else(|| format!("timeline instance '{instance_id}' is not loaded"))?;
        if instance.player.clip_duration(clip_index).is_none() {
            return Err(format!(
                "timeline instance '{instance_id}' has no clip {clip_index}"
            ));
        }
        if instance.player.current_clip_index() != Some(clip_index) {
            instance.player.play_index(clip_index);
            instance.player.stop();
        }
        match command {
            TimelinePlaybackCommand::Play { .. } => instance.player.resume(),
            TimelinePlaybackCommand::Pause { .. } => instance.player.stop(),
            TimelinePlaybackCommand::Seek { time, .. } => {
                let duration = instance.player.clip_duration(clip_index).unwrap_or(0.0);
                instance.player.seek(time.clamp(0.0, duration));
            }
            TimelinePlaybackCommand::SetLooping { looping, .. } => {
                instance.player.set_looping(looping)
            }
        }
        Ok(())
    }

    pub fn timeline_playback_snapshot(&self) -> TimelinePlaybackSnapshot {
        let Some(instance) = self
            .instances
            .iter()
            .find(|instance| instance.player.clip_count() > 0)
        else {
            return TimelinePlaybackSnapshot::default();
        };
        let clip_index = instance.player.current_clip_index().unwrap_or(0);
        TimelinePlaybackSnapshot {
            revision: 0,
            sampled_at_unix_ms: 0,
            available: true,
            instance_id: Some(instance.id.clone()),
            clip_index: Some(clip_index),
            time: instance.player.time(),
            duration: instance.player.clip_duration(clip_index).unwrap_or(0.0),
            playing: instance.player.is_playing(),
            looping: instance.player.is_looping(),
        }
    }

    pub fn apply_scene_command(&mut self, command: SceneCommand) -> Result<(), String> {
        match command {
            SceneCommand::SetBaseColor { node_id, color } if node_id == CUBE_ID => {
                if let Some(cube) = self.cube.as_mut() {
                    cube.set_color(Color::new(color[0], color[1], color[2], color[3]));
                } else {
                    return Err(format!("unsupported scene node '{node_id}'"));
                }
            }
            SceneCommand::SetMetallic { node_id, value } if node_id == CUBE_ID => {
                if let Some(cube) = self.cube.as_mut() {
                    cube.set_metallic(value);
                } else {
                    return Err(format!("unsupported scene node '{node_id}'"));
                }
            }
            SceneCommand::SetRoughness { node_id, value } if node_id == CUBE_ID => {
                if let Some(cube) = self.cube.as_mut() {
                    cube.set_roughness(value);
                } else {
                    return Err(format!("unsupported scene node '{node_id}'"));
                }
            }
            SceneCommand::SetVisibility { node_id, visible } => {
                match node_id.as_str() {
                    SCENE_ID => self.scene.set_visible(visible),
                    KEY_LIGHT_ID => self.key_light.set_visible(visible),
                    CUBE_ID => self
                        .cube
                        .as_mut()
                        .ok_or_else(|| format!("unsupported scene node '{node_id}'"))?
                        .set_visible(visible),
                    _ => self
                        .instances
                        .iter_mut()
                        .find(|instance| instance.id == node_id)
                        .ok_or_else(|| format!("unsupported scene node '{node_id}'"))?
                        .root
                        .set_visible(visible),
                };
            }
            SceneCommand::SetBaseColor { node_id, .. }
            | SceneCommand::SetMetallic { node_id, .. }
            | SceneCommand::SetRoughness { node_id, .. } => {
                return Err(format!("unsupported scene node '{node_id}'"));
            }
        }
        Ok(())
    }

    pub fn scene_projection(&self, selected_id: Option<&str>) -> SceneProjection {
        let selected_node_id = selected_id
            .filter(|id| self.has_node(id))
            .map(ToOwned::to_owned);

        let mut nodes = vec![
            SceneNodeSummary {
                id: SCENE_ID.to_string(),
                parent: None,
                label: self.scene_label.clone(),
                kind: "scene".to_string(),
                visible: self.scene.is_visible(),
            },
            SceneNodeSummary {
                id: KEY_LIGHT_ID.to_string(),
                parent: Some(SCENE_ID.to_string()),
                label: "Key Light".to_string(),
                kind: "light".to_string(),
                visible: self.key_light.is_visible(),
            },
        ];

        if let Some(cube) = &self.cube {
            nodes.push(SceneNodeSummary {
                id: CUBE_ID.to_string(),
                parent: Some(SCENE_ID.to_string()),
                label: "Cube".to_string(),
                kind: "mesh".to_string(),
                visible: cube.is_visible(),
            });
        }
        nodes.extend(self.instances.iter().map(runtime_instance_summary));

        let selected = selected_node_id
            .as_deref()
            .and_then(|id| self.selected_details(id));

        SceneProjection {
            revision: 0,
            selected_node_id,
            nodes,
            selected,
            last_processed_sequence: 0,
            command_results: Vec::new(),
        }
    }

    fn selected_details(&self, node_id: &str) -> Option<SelectedSceneNode> {
        let node = match node_id {
            SCENE_ID => &self.scene,
            KEY_LIGHT_ID => &self.key_light,
            CUBE_ID => self.cube.as_ref()?,
            _ => self
                .instances
                .iter()
                .find(|instance| instance.id == node_id)
                .map(|instance| &instance.root)?,
        };
        let pose = node.local_transformation();
        let transform = SceneTransform {
            translation: pose.translation.to_array(),
            rotation: pose.rotation.to_array(),
            scale: node.local_scale().to_array(),
        };
        let material = if node_id == CUBE_ID && self.cube.is_some() {
            let mut material = None;
            node.apply_to_object(&mut |object| {
                let data = object.data();
                let color = data.color();
                material = Some(SceneMaterial {
                    color: [color.r, color.g, color.b, color.a],
                    metallic: data.metallic(),
                    roughness: data.roughness(),
                });
            });
            material
        } else {
            None
        };

        Some(SelectedSceneNode {
            id: node_id.to_string(),
            transform,
            material,
        })
    }
}

fn build_runtime_scene(
    scene_document: &Scene,
    resolved_assets: &[ResolvedAssetPath],
) -> Result<RuntimeScene, RendererError> {
    let mut scene = SceneNode3d::empty();
    let mut key_light = scene.add_light(Light::point(100.0));
    key_light.set_position(Vec3::new(2.5, 3.0, -2.0));

    let paths_by_id: HashMap<&str, &Path> = resolved_assets
        .iter()
        .map(|resolved| (resolved.asset_id.as_str(), resolved.resolved_path.as_path()))
        .collect();
    let mut instances = Vec::with_capacity(scene_document.instances.len());

    for instance in &scene_document.instances {
        let Some(asset) = scene_document
            .assets
            .iter()
            .find(|asset| asset.id == instance.asset)
        else {
            return Err(RendererError::MissingResolvedAsset {
                asset_id: instance.asset.clone(),
                instance_id: instance.id.clone(),
            });
        };
        let path = paths_by_id.get(asset.id.as_str()).ok_or_else(|| {
            RendererError::MissingResolvedAsset {
                asset_id: asset.id.clone(),
                instance_id: instance.id.clone(),
            }
        })?;
        let (translation, rotation, scale) = instance_runtime_transform(instance)?;

        let (mut root, player) = match asset.kind.as_str() {
            "gltf" => {
                let loaded = catch_unwind(AssertUnwindSafe(|| kiss3d::loader::gltf::load(path)))
                    .map_err(|_| RendererError::AssetLoad {
                        instance_id: instance.id.clone(),
                        asset_id: asset.id.clone(),
                        path: path.display().to_string(),
                        message: "vendor glTF loader panicked".to_string(),
                    })?
                    .map_err(|error| RendererError::AssetLoad {
                        instance_id: instance.id.clone(),
                        asset_id: asset.id.clone(),
                        path: path.display().to_string(),
                        message: error.to_string(),
                    })?;
                (loaded.root, loaded.player)
            }
            "fbx" => {
                let loaded = catch_unwind(AssertUnwindSafe(|| kiss3d::loader::fbx::load(path)))
                    .map_err(|_| RendererError::AssetLoad {
                        instance_id: instance.id.clone(),
                        asset_id: asset.id.clone(),
                        path: path.display().to_string(),
                        message: "vendor FBX loader panicked".to_string(),
                    })?
                    .map_err(|message| RendererError::AssetLoad {
                        instance_id: instance.id.clone(),
                        asset_id: asset.id.clone(),
                        path: path.display().to_string(),
                        message,
                    })?;
                let mut player = loaded.player;
                if player.clip_count() > 0 {
                    player.play_index(0);
                }
                (loaded.root, player)
            }
            kind => {
                return Err(RendererError::AssetLoad {
                    instance_id: instance.id.clone(),
                    asset_id: asset.id.clone(),
                    path: path.display().to_string(),
                    message: format!("unsupported asset kind '{kind}'"),
                });
            }
        };

        root.set_position(translation);
        root.set_rotation(rotation);
        root.set_local_scale(scale.x, scale.y, scale.z);
        root.set_visible(instance.visible);
        scene.add_child(root.clone());
        instances.push(RuntimeInstance {
            id: instance.id.clone(),
            root,
            player,
        });
    }

    Ok(RuntimeScene {
        scene,
        key_light,
        cube: None,
        instances,
        scene_label: scene_document
            .name
            .clone()
            .unwrap_or_else(|| "Scene".to_string()),
        default_node_id: scene_document
            .instances
            .first()
            .map(|instance| instance.id.clone())
            .unwrap_or_else(|| SCENE_ID.to_string()),
    })
}

/// Queues a Y-up editor reference grid on the XZ plane and the positive XYZ axes.
/// Kiss3d debug lines are frame-local, so this must run immediately before each render.
fn draw_reference_grid_and_axes(window: &mut Window) {
    let extent = GRID_HALF_EXTENT as f32;
    for index in -GRID_HALF_EXTENT..=GRID_HALF_EXTENT {
        let coordinate = index as f32;
        let color = if index % 5 == 0 {
            GRID_MAJOR_COLOR
        } else {
            GRID_MINOR_COLOR
        };
        window.draw_line(
            Vec3::new(coordinate, 0.0, -extent),
            Vec3::new(coordinate, 0.0, extent),
            color,
            1.0,
            false,
        );
        window.draw_line(
            Vec3::new(-extent, 0.0, coordinate),
            Vec3::new(extent, 0.0, coordinate),
            color,
            1.0,
            false,
        );
    }

    window.draw_line(Vec3::ZERO, Vec3::X * AXIS_LENGTH, X_AXIS_COLOR, 2.5, false);
    window.draw_line(Vec3::ZERO, Vec3::Y * AXIS_LENGTH, Y_AXIS_COLOR, 2.5, false);
    window.draw_line(Vec3::ZERO, Vec3::Z * AXIS_LENGTH, Z_AXIS_COLOR, 2.5, false);
}

fn viewport_rect_to_physical(rect: ViewportRect) -> RenderViewport {
    let values = [rect.x, rect.y, rect.width, rect.height, rect.scale_factor];
    if !values.iter().all(|value| value.is_finite()) || rect.scale_factor <= 0.0 {
        return RenderViewport::new(0, 0, 0, 0);
    }

    let scale = rect.scale_factor;
    // Intersect against the non-negative surface quadrant after computing the
    // raw edges. Clamping the origin first would incorrectly translate pixels
    // that are actually outside the left/top surface edge into view.
    let left = (rect.x * scale).floor().max(0.0);
    let top = (rect.y * scale).floor().max(0.0);
    let right = ((rect.x + rect.width.max(0.0)) * scale).ceil().max(0.0);
    let bottom = ((rect.y + rect.height.max(0.0)) * scale).ceil().max(0.0);
    let x = left as u32;
    let y = top as u32;
    RenderViewport::new(
        x,
        y,
        (right as u32).saturating_sub(x),
        (bottom as u32).saturating_sub(y),
    )
}

fn instance_runtime_transform(
    instance: &SceneInstance,
) -> Result<(Vec3, Quat, Vec3), RendererError> {
    let conversion = |value: f64, field: &str| {
        let value = value as f32;
        if value.is_finite() {
            Ok(value)
        } else {
            Err(RendererError::InvalidInstanceTransform {
                instance_id: instance.id.clone(),
                message: format!("{field} overflows f32"),
            })
        }
    };

    let translation = Vec3::from_array([
        conversion(instance.transform.translation[0], "translation")?,
        conversion(instance.transform.translation[1], "translation")?,
        conversion(instance.transform.translation[2], "translation")?,
    ]);
    let rotation_values = [
        conversion(instance.transform.rotation[0], "rotation")?,
        conversion(instance.transform.rotation[1], "rotation")?,
        conversion(instance.transform.rotation[2], "rotation")?,
        conversion(instance.transform.rotation[3], "rotation")?,
    ];
    let rotation = Quat::from_array(rotation_values);
    let norm = rotation.length();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return Err(RendererError::InvalidInstanceTransform {
            instance_id: instance.id.clone(),
            message: "rotation quaternion must have non-zero finite length".to_string(),
        });
    }
    let scale_values = [
        conversion(instance.transform.scale[0], "scale")?,
        conversion(instance.transform.scale[1], "scale")?,
        conversion(instance.transform.scale[2], "scale")?,
    ];
    if scale_values.iter().any(|value| *value <= 0.0) {
        return Err(RendererError::InvalidInstanceTransform {
            instance_id: instance.id.clone(),
            message: "scale axes must be greater than zero".to_string(),
        });
    }

    Ok((
        translation,
        rotation.normalize(),
        Vec3::from_array(scale_values),
    ))
}

fn runtime_instance_summary(instance: &RuntimeInstance) -> SceneNodeSummary {
    SceneNodeSummary {
        id: instance.id.clone(),
        parent: Some(SCENE_ID.to_string()),
        label: instance.id.clone(),
        kind: "mesh".to_string(),
        visible: instance.root.is_visible(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{SceneInstance, SceneTransform};

    fn instance(transform: SceneTransform) -> SceneInstance {
        SceneInstance {
            id: "model-1".to_string(),
            asset: "model".to_string(),
            transform,
            visible: true,
        }
    }

    #[test]
    fn runtime_transform_normalizes_valid_rotation() {
        let (_, rotation, scale) = instance_runtime_transform(&instance(SceneTransform {
            translation: [1.0, 2.0, 3.0],
            rotation: [0.0, 0.0, 0.0, 2.0],
            scale: [1.0, 2.0, 3.0],
        }))
        .unwrap();
        assert!((rotation.length() - 1.0).abs() < 1e-6);
        assert_eq!(scale, Vec3::new(1.0, 2.0, 3.0));
    }

    #[test]
    fn runtime_transform_rejects_zero_rotation() {
        let error = instance_runtime_transform(&instance(SceneTransform {
            translation: [0.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 0.0],
            scale: [1.0, 1.0, 1.0],
        }))
        .unwrap_err();
        assert!(error.to_string().contains("model-1"));
        assert!(error.to_string().contains("quaternion"));
    }

    #[test]
    fn runtime_transform_rejects_f32_overflow() {
        let error = instance_runtime_transform(&instance(SceneTransform {
            translation: [f64::MAX, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
        }))
        .unwrap_err();
        assert!(error.to_string().contains("translation"));
        assert!(error.to_string().contains("overflows f32"));
    }

    #[test]
    fn runtime_projection_summary_uses_instance_id_without_cube() {
        let mut root = SceneNode3d::empty();
        root.set_visible(false);
        let summary = runtime_instance_summary(&RuntimeInstance {
            id: "box-instance".to_string(),
            root,
            player: AnimationPlayer::new(Vec::new()),
        });
        assert_eq!(summary.id, "box-instance");
        assert_eq!(summary.label, "box-instance");
        assert_eq!(summary.parent.as_deref(), Some(SCENE_ID));
        assert!(!summary.visible);
    }

    #[test]
    fn viewport_rect_conversion_uses_physical_edges_and_dpr() {
        assert_eq!(
            viewport_rect_to_physical(ViewportRect {
                x: 220.25,
                y: 32.5,
                width: 780.2,
                height: 528.1,
                scale_factor: 1.5,
            }),
            RenderViewport::new(330, 48, 1171, 793)
        );
    }

    #[test]
    fn viewport_rect_conversion_clamps_negative_origin_and_zero_size() {
        assert_eq!(
            viewport_rect_to_physical(ViewportRect {
                x: -10.0,
                y: -20.0,
                width: 0.0,
                height: 12.0,
                scale_factor: 1.5,
            }),
            RenderViewport::new(0, 0, 0, 0)
        );
    }

    #[test]
    fn viewport_rect_conversion_clips_partial_and_fully_negative_rects() {
        assert_eq!(
            viewport_rect_to_physical(ViewportRect {
                x: -10.0,
                y: -20.0,
                width: 100.0,
                height: 50.0,
                scale_factor: 1.0,
            }),
            RenderViewport::new(0, 0, 90, 30)
        );
        assert_eq!(
            viewport_rect_to_physical(ViewportRect {
                x: -100.0,
                y: -100.0,
                width: 50.0,
                height: 50.0,
                scale_factor: 1.0,
            }),
            RenderViewport::new(0, 0, 0, 0)
        );
    }

    #[test]
    fn viewport_rect_conversion_fails_closed_for_invalid_values() {
        assert_eq!(
            viewport_rect_to_physical(ViewportRect {
                x: f32::NAN,
                y: 0.0,
                width: 10.0,
                height: 10.0,
                scale_factor: 1.0,
            }),
            RenderViewport::new(0, 0, 0, 0)
        );
    }
}

pub fn apply_viewport_rect(renderer: &mut Renderer, rect: ViewportRect) {
    renderer.set_viewport_rect(rect);
}
