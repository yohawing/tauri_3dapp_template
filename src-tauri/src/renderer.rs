use std::collections::HashMap;
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::time::Instant;

use kiss3d::color::Color;
use kiss3d::light::LightType;
use kiss3d::post_processing::Tonemap;
use kiss3d::prelude::{
    AnimationPlayer, Camera3d, CanvasSetup, Light, NumSamples, OrbitCamera3d, Projection, Quat,
    RenderFrameStatus, RenderViewport, SceneNode3d, SurfaceSkipReason, SurfaceUnavailableReason,
    Vec3, Window, ORANGE,
};

use crate::performance::{target_from_env, PerformanceSampler};
use crate::protocol::{
    CameraProjection, CameraSettings, CameraState, ViewportBackgroundMode, ViewportDisplayMode,
    ViewportDisplaySettings, ViewportEnvironmentSettings, ViewportLightingSettings, ViewportRect,
    ViewportTonemap,
};
use crate::scene::{ResolvedAssetPath, Scene, SceneInstance};
use crate::scene_projection::{
    SceneCommand, SceneLight, SceneMaterial, SceneNodeSummary, SceneProjection, SceneTransform,
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
const BONE_COLOR: Color = Color::new(1.0, 0.65, 0.15, 1.0);
const BONE_OVERLAY_DEPTH_BIAS: f32 = 0.995;
const BONE_RING_SEGMENTS: usize = 16;
// Maya-style LocalAxis stays inside the joint sphere and does not scale with
// the distance to the next joint.
const BONE_AXIS_LENGTH_FACTOR: f32 = 0.8;
// Keep the Maya-style joint marker and the pyramid cross-section independent
// from the distance to the next joint.  The latter is derived from the
// sphere diameter below: side = diameter / sqrt(2).
const BONE_JOINT_RADIUS: f32 = 0.01;
const BONE_PYRAMID_BASE_OFFSET_FACTOR: f32 = 0.06;
const BONE_AXIS_WIDTH: f32 = 2.0;
const BONE_RING_WIDTH: f32 = 1.5;
const BONE_PYRAMID_WIDTH: f32 = 2.25;

const SURFACE_STATUS_SELF_TEST_ENV: &str = "TAURI3D_SURFACE_STATUS_SELF_TEST";

fn surface_status_self_test_from_env() -> Option<RenderFrameStatus> {
    std::env::var(SURFACE_STATUS_SELF_TEST_ENV)
        .ok()
        .and_then(|value| parse_surface_status_self_test(&value))
}

fn parse_surface_status_self_test(value: &str) -> Option<RenderFrameStatus> {
    match value.trim().to_ascii_lowercase().as_str() {
        "timeout" => Some(RenderFrameStatus::Skipped(SurfaceSkipReason::Timeout)),
        "occluded" => Some(RenderFrameStatus::Skipped(SurfaceSkipReason::Occluded)),
        "outdated" | "outdated-after-reconfigure" => Some(RenderFrameStatus::Skipped(
            SurfaceSkipReason::OutdatedAfterReconfigure,
        )),
        "zero-sized" | "zero-sized-surface" => Some(RenderFrameStatus::Skipped(
            SurfaceSkipReason::ZeroSizedSurface,
        )),
        "lost" => Some(RenderFrameStatus::SurfaceUnavailable(
            SurfaceUnavailableReason::Lost,
        )),
        "validation" => Some(RenderFrameStatus::SurfaceUnavailable(
            SurfaceUnavailableReason::Validation,
        )),
        "missing" | "missing-surface" => Some(RenderFrameStatus::SurfaceUnavailable(
            SurfaceUnavailableReason::MissingSurface,
        )),
        "closed" => Some(RenderFrameStatus::Closed),
        _ => None,
    }
}

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
    AnimationMetadataMismatch {
        metadata_clips: usize,
        runtime_clips: usize,
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
            Self::AnimationMetadataMismatch {
                metadata_clips,
                runtime_clips,
            } => write!(
                formatter,
                "animation metadata/runtime mismatch: metadata has {metadata_clips} clips, runtime has {runtime_clips}"
            ),
        }
    }
}

impl std::error::Error for RendererError {}

struct RuntimeInstance {
    id: String,
    root: SceneNode3d,
    player: AnimationPlayer,
    bone_edges: Vec<(SceneNode3d, SceneNode3d)>,
    bones: Vec<RuntimeBone>,
}

struct RuntimeBone {
    source_index: usize,
    parent_source_index: Option<usize>,
    label: String,
    node: SceneNode3d,
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
    camera_settings: CameraSettings,
    display: ViewportDisplaySettings,
    environment_request: ViewportEnvironmentSettings,
    environment_active: ViewportEnvironmentSettings,
    performance_target: Option<(u32, u32)>,
    performance_sampler: Option<PerformanceSampler>,
    animation_clock: Instant,
    surface_status_injection: Option<RenderFrameStatus>,
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
        kiss_window.set_background_color(Color::new(0.0, 0.0, 0.0, 0.0));

        let mut scene = SceneNode3d::empty();
        let key_light = scene.add_light(Light::directional(Vec3::new(-0.45, -1.0, -0.35)));
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
            camera_settings: CameraSettings::default(),
            display: ViewportDisplaySettings::default(),
            environment_request: ViewportEnvironmentSettings::default(),
            environment_active: ViewportEnvironmentSettings::default(),
            performance_target,
            performance_sampler: PerformanceSampler::from_env(),
            animation_clock: Instant::now(),
            surface_status_injection: surface_status_self_test_from_env(),
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
        kiss_window.set_background_color(Color::new(0.0, 0.0, 0.0, 0.0));

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
            camera_settings: CameraSettings::default(),
            display: ViewportDisplaySettings::default(),
            environment_request: ViewportEnvironmentSettings::default(),
            environment_active: ViewportEnvironmentSettings::default(),
            performance_target,
            performance_sampler: PerformanceSampler::from_env(),
            animation_clock: Instant::now(),
            surface_status_injection: surface_status_self_test_from_env(),
        })
    }

    /// Build a replacement scene completely before swapping it into the live
    /// renderer, so a failed File > Open leaves the current scene intact.
    pub fn replace_with_scene(
        &mut self,
        scene_document: &Scene,
        resolved_assets: &[ResolvedAssetPath],
        expected_animation_clip_count: usize,
    ) -> Result<(), RendererError> {
        let runtime = build_runtime_scene(scene_document, resolved_assets)?;
        let runtime_clip_count = runtime
            .instances
            .iter()
            .map(|instance| instance.player.clip_count())
            .sum::<usize>();
        if runtime_clip_count != expected_animation_clip_count {
            return Err(RendererError::AnimationMetadataMismatch {
                metadata_clips: expected_animation_clip_count,
                runtime_clips: runtime_clip_count,
            });
        }
        self.scene = runtime.scene;
        self.key_light = runtime.key_light;
        self.cube = runtime.cube;
        self.instances = runtime.instances;
        self.scene_label = runtime.scene_label;
        self.default_node_id = runtime.default_node_id;
        self.animation_clock = Instant::now();
        self.apply_display_mode(self.display.mode);
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

    /// Apply editor-only projection/FOV settings to the Native camera. The
    /// orbit pose remains owned by `CameraState`; changing these values never
    /// alters target, yaw, pitch, or distance.
    pub fn set_camera_settings(&mut self, settings: CameraSettings) {
        self.camera.set_projection(match settings.projection {
            CameraProjection::Perspective => Projection::Perspective,
            CameraProjection::Orthographic => Projection::Orthographic,
        });
        self.camera.set_fov(
            settings
                .fov_degrees
                .to_radians()
                .clamp(0.01, std::f32::consts::PI - 0.01),
        );
        // OrbitCamera3d::set_fov updates the stored value but (in the vendor
        // API) does not rebuild projection matrices. Re-running look_at keeps
        // the current eye/target and refreshes the derived matrices.
        let eye = self.camera.eye();
        let target = self.camera.at();
        self.camera.look_at(eye, target);
        self.camera_settings = settings;
    }

    pub fn set_viewport_rect(&mut self, rect: ViewportRect) {
        let viewport = self
            .performance_target
            .map(|(width, height)| RenderViewport::new(0, 0, width, height))
            .unwrap_or_else(|| viewport_rect_to_physical(rect));
        self.window.set_render_viewport(Some(viewport));
    }

    /// Apply transient editor-only display flags to the current Native scene.
    /// Scene JSON and authored material values are intentionally untouched.
    pub fn set_viewport_display(&mut self, settings: ViewportDisplaySettings) {
        if self.display.mode != settings.mode {
            self.apply_display_mode(settings.mode);
        }
        self.display = settings;
    }

    /// Apply editor-only Native lighting and background controls. These values
    /// are intentionally separate from Scene material/light data.
    pub fn set_viewport_lighting(&mut self, settings: ViewportLightingSettings) {
        self.window.set_exposure(settings.exposure);
        self.window.set_tonemap(match settings.tonemap {
            ViewportTonemap::None => Tonemap::None,
            ViewportTonemap::Reinhard => Tonemap::Reinhard,
            ViewportTonemap::Aces => Tonemap::Aces,
        });
        self.window.set_ambient(settings.ambient_intensity);
        self.window.set_ambient_color(Color::new(
            settings.ambient_color[0],
            settings.ambient_color[1],
            settings.ambient_color[2],
            1.0,
        ));
        self.window.set_shadows_enabled(settings.shadows_enabled);
        self.window
            .set_shadow_resolution(settings.shadow_resolution);
        self.window.set_shadow_softness(settings.shadow_softness);
        let background = match settings.background_mode {
            ViewportBackgroundMode::Transparent => Color::new(0.0, 0.0, 0.0, 0.0),
            ViewportBackgroundMode::Solid => Color::new(
                settings.background_color[0],
                settings.background_color[1],
                settings.background_color[2],
                1.0,
            ),
        };
        self.window.set_background_color(background);
    }

    /// Apply a validated editor-only equirectangular skybox/IBL request. A
    /// failed decode leaves the previously active environment untouched.
    pub fn set_viewport_environment(
        &mut self,
        settings: ViewportEnvironmentSettings,
        encoded: Option<&[u8]>,
    ) {
        if self.environment_request == settings {
            return;
        }
        self.environment_request = settings.clone();
        if !settings.enabled {
            self.window.clear_skybox();
            self.environment_active = settings;
            return;
        }

        let needs_load = !self.window.has_skybox() || self.environment_active.path != settings.path;
        if needs_load {
            let Some(bytes) = encoded else {
                eprintln!("[viewport-environment] validated HDRI bytes are unavailable");
                return;
            };
            if !self.window.set_skybox_from_memory(bytes) {
                eprintln!(
                    "[viewport-environment] failed to apply decoded HDRI: {}",
                    settings.path
                );
                return;
            }
        }
        self.window
            .set_skybox_orientation(settings.rotation_degrees.to_radians(), settings.intensity);
        self.environment_active = settings;
    }

    fn apply_display_mode(&mut self, mode: ViewportDisplayMode) {
        match mode {
            ViewportDisplayMode::Lit => {
                self.scene.set_surface_rendering_activation_recursive(true);
                self.scene.set_lines_width_recursive(0.0, false);
            }
            ViewportDisplayMode::Wireframe => {
                self.scene.set_surface_rendering_activation_recursive(false);
                self.scene.set_lines_width_recursive(1.5, false);
            }
        }
    }

    pub fn render(&mut self) -> RenderFrameStatus {
        if let Some(status) = self.surface_status_injection.take() {
            return status;
        }
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
        if self.display.show_grid {
            draw_reference_grid_and_axes(&mut self.window);
        }
        if self.display.show_bones {
            draw_bone_edges(&mut self.window, &self.instances);
        }
        let status = pollster::block_on(
            self.window
                .render_3d_status(&mut self.scene, &mut self.camera),
        );
        if let (Some(sampler), Some(timings)) = (
            self.performance_sampler.as_mut(),
            self.window.render_timings(),
        ) {
            sampler.observe(timings, self.performance_target);
        }
        status
    }

    pub fn has_node(&self, node_id: &str) -> bool {
        node_id == SCENE_ID
            || node_id == KEY_LIGHT_ID
            || (node_id == CUBE_ID && self.cube.is_some())
            || self.instances.iter().any(|instance| instance.id == node_id)
            || self.runtime_bone(node_id).is_some()
    }

    /// Return true only for top-level runtime instances loaded from the
    /// current Scene document. Built-in nodes and generated bone IDs are
    /// intentionally excluded so callers can persist only document-backed
    /// visibility edits.
    pub fn is_runtime_instance(&self, node_id: &str) -> bool {
        is_runtime_instance_id(&self.instances, node_id)
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
            emitted_at_unix_ms: 0,
            event_sequence: 0,
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
            SceneCommand::SetLightColor { node_id, color } if node_id == KEY_LIGHT_ID => {
                self.key_light.modify_light(|light| {
                    light.color = Color::new(color[0], color[1], color[2], color[3]);
                });
            }
            SceneCommand::SetLightIntensity { node_id, value } if node_id == KEY_LIGHT_ID => {
                self.key_light.modify_light(|light| light.intensity = value);
            }
            SceneCommand::SetLightDirection { node_id, direction } if node_id == KEY_LIGHT_ID => {
                let direction = Vec3::from_array(direction).normalize();
                let mut applied = false;
                self.key_light.modify_light(|light| {
                    if let LightType::Directional(current) = &mut light.light_type {
                        *current = direction;
                        applied = true;
                    }
                });
                if !applied {
                    return Err(format!("scene node '{node_id}' is not directional"));
                }
            }
            SceneCommand::SetLightEnabled { node_id, enabled } if node_id == KEY_LIGHT_ID => {
                self.key_light.modify_light(|light| light.enabled = enabled);
            }
            SceneCommand::SetLightCastsShadows {
                node_id,
                casts_shadows,
            } if node_id == KEY_LIGHT_ID => {
                self.key_light
                    .modify_light(|light| light.casts_shadows = casts_shadows);
            }
            SceneCommand::SetVisibility { node_id, visible } => {
                match node_id.as_str() {
                    SCENE_ID => {
                        self.scene.set_visible(visible);
                    }
                    KEY_LIGHT_ID => {
                        self.key_light.set_visible(visible);
                    }
                    CUBE_ID => {
                        self.cube
                            .as_mut()
                            .ok_or_else(|| format!("unsupported scene node '{node_id}'"))?
                            .set_visible(visible);
                    }
                    _ => {
                        if let Some(bone) = self.runtime_bone_mut(&node_id) {
                            bone.node.set_visible(visible);
                        } else {
                            self.instances
                                .iter_mut()
                                .find(|instance| instance.id == node_id)
                                .ok_or_else(|| format!("unsupported scene node '{node_id}'"))?
                                .root
                                .set_visible(visible);
                        }
                    }
                };
            }
            SceneCommand::SetBaseColor { node_id, .. }
            | SceneCommand::SetMetallic { node_id, .. }
            | SceneCommand::SetRoughness { node_id, .. }
            | SceneCommand::SetLightColor { node_id, .. }
            | SceneCommand::SetLightIntensity { node_id, .. }
            | SceneCommand::SetLightDirection { node_id, .. }
            | SceneCommand::SetLightEnabled { node_id, .. }
            | SceneCommand::SetLightCastsShadows { node_id, .. } => {
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
        nodes.extend(self.instances.iter().flat_map(runtime_instance_summaries));

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
                .map(|instance| &instance.root)
                .or_else(|| self.runtime_bone(node_id).map(|bone| &bone.node))?,
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
            light: project_light(node),
        })
    }
}

fn is_runtime_instance_id(instances: &[RuntimeInstance], node_id: &str) -> bool {
    if matches!(node_id, SCENE_ID | KEY_LIGHT_ID | CUBE_ID) {
        return false;
    }
    if instances.iter().any(|instance| {
        instance
            .bones
            .iter()
            .any(|bone| runtime_bone_id(&instance.id, bone.source_index) == node_id)
    }) {
        return false;
    }
    instances.iter().any(|instance| instance.id == node_id)
}

fn project_light(node: &SceneNode3d) -> Option<SceneLight> {
    let light = node.light()?;
    let direction = match &light.light_type {
        LightType::Directional(direction) => Some(direction.to_array()),
        _ => None,
    };
    let (light_type, attenuation_radius, inner_cone_angle, outer_cone_angle) = match light
        .light_type
    {
        LightType::Point { attenuation_radius } => ("point", Some(attenuation_radius), None, None),
        LightType::Directional(_) => ("directional", None, None, None),
        LightType::Spot {
            inner_cone_angle,
            outer_cone_angle,
            attenuation_radius,
        } => (
            "spot",
            Some(attenuation_radius),
            Some(inner_cone_angle),
            Some(outer_cone_angle),
        ),
    };
    Some(SceneLight {
        light_type: light_type.to_string(),
        direction,
        color: [light.color.r, light.color.g, light.color.b, light.color.a],
        intensity: light.intensity,
        radius: light.radius,
        enabled: light.enabled,
        casts_shadows: light.casts_shadows,
        attenuation_radius,
        inner_cone_angle,
        outer_cone_angle,
    })
}

fn build_runtime_scene(
    scene_document: &Scene,
    resolved_assets: &[ResolvedAssetPath],
) -> Result<RuntimeScene, RendererError> {
    let mut scene = SceneNode3d::empty();
    let key_light = scene.add_light(Light::directional(Vec3::new(-0.45, -1.0, -0.35)));

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

        let (mut root, player, bone_edges, skeleton_nodes) = match asset.kind.as_str() {
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
                (
                    loaded.root,
                    loaded.player,
                    loaded.skeleton_edges,
                    loaded.skeleton_nodes,
                )
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
                (
                    loaded.root,
                    player,
                    loaded.skeleton_edges,
                    loaded.skeleton_nodes,
                )
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
            bone_edges,
            bones: skeleton_nodes
                .into_iter()
                .map(|bone| RuntimeBone {
                    source_index: bone.index,
                    parent_source_index: bone.parent_index,
                    label: bone.name,
                    node: bone.node,
                })
                .collect(),
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

fn draw_bone_edges(window: &mut Window, instances: &[RuntimeInstance]) {
    let mut joints: HashMap<u64, SceneNode3d> = HashMap::new();

    for instance in instances {
        if !instance.root.is_visible() {
            continue;
        }

        for (parent, child) in &instance.bone_edges {
            let parent_position = parent.world_matrix().transform_point3(Vec3::ZERO);
            let child_position = child.world_matrix().transform_point3(Vec3::ZERO);
            if !parent_position.is_finite() || !child_position.is_finite() {
                continue;
            }

            let delta = child_position - parent_position;
            let edge_length = delta.length();
            if !edge_length.is_finite() {
                continue;
            }

            register_bone_joint(&mut joints, parent);
            register_bone_joint(&mut joints, child);

            if edge_length > BONE_EPSILON {
                draw_bone_pyramid(window, parent, parent_position, child_position, edge_length);
            }
        }
    }

    for (_, joint) in joints {
        draw_bone_joint_gizmo(window, &joint);
    }
}

const BONE_EPSILON: f32 = 1.0e-8;

fn register_bone_joint(joints: &mut HashMap<u64, SceneNode3d>, node: &SceneNode3d) {
    joints.entry(node.ptr_id()).or_insert_with(|| node.clone());
}

fn draw_bone_joint_gizmo(window: &mut Window, node: &SceneNode3d) {
    let world = node.world_matrix();
    let center = world.transform_point3(Vec3::ZERO);
    if !center.is_finite() {
        return;
    }

    let [local_x, local_y, local_z] = bone_local_basis(node, center);
    let radius = bone_joint_radius();
    let axis_length = radius * BONE_AXIS_LENGTH_FACTOR;

    draw_bone_line(
        window,
        center,
        center + local_x * axis_length,
        X_AXIS_COLOR,
        BONE_AXIS_WIDTH,
    );
    draw_bone_line(
        window,
        center,
        center + local_y * axis_length,
        Y_AXIS_COLOR,
        BONE_AXIS_WIDTH,
    );
    draw_bone_line(
        window,
        center,
        center + local_z * axis_length,
        Z_AXIS_COLOR,
        BONE_AXIS_WIDTH,
    );

    // Maya-style joint sphere: three orthogonal great circles, colored by
    // their corresponding local axis.
    draw_bone_ring(window, center, local_y, local_z, radius, X_AXIS_COLOR);
    draw_bone_ring(window, center, local_z, local_x, radius, Y_AXIS_COLOR);
    draw_bone_ring(window, center, local_x, local_y, radius, Z_AXIS_COLOR);
}

fn draw_bone_pyramid(
    window: &mut Window,
    parent: &SceneNode3d,
    parent_position: Vec3,
    child_position: Vec3,
    edge_length: f32,
) {
    let direction = unit_or(child_position - parent_position, Vec3::Y);
    let [local_x, local_y, local_z] = bone_local_basis(parent, parent_position);

    // Keep the square stable even when the bone points almost along one of
    // the joint's local axes.
    let mut side = local_x;
    if direction.dot(side).abs() > 0.85 {
        side = local_y;
    }
    if direction.dot(side).abs() > 0.85 {
        side = local_z;
    }
    let side_a = unit_or(
        side - direction * direction.dot(side),
        perpendicular_to(direction),
    );
    let side_b = unit_or(direction.cross(side_a), perpendicular_to(direction));

    let half_width = bone_pyramid_half_width();
    let base_center = parent_position + direction * (edge_length * BONE_PYRAMID_BASE_OFFSET_FACTOR);
    let corners = [
        base_center + side_a * half_width + side_b * half_width,
        base_center - side_a * half_width + side_b * half_width,
        base_center - side_a * half_width - side_b * half_width,
        base_center + side_a * half_width - side_b * half_width,
    ];

    for index in 0..corners.len() {
        let next = (index + 1) % corners.len();
        draw_bone_line(
            window,
            corners[index],
            corners[next],
            BONE_COLOR,
            BONE_PYRAMID_WIDTH,
        );
        draw_bone_line(
            window,
            corners[index],
            child_position,
            BONE_COLOR,
            BONE_PYRAMID_WIDTH,
        );
    }
}

fn draw_bone_ring(
    window: &mut Window,
    center: Vec3,
    axis_a: Vec3,
    axis_b: Vec3,
    radius: f32,
    color: Color,
) {
    let tau = std::f32::consts::PI * 2.0;
    let mut previous = center + axis_a * radius;
    for segment in 1..=BONE_RING_SEGMENTS {
        let angle = tau * segment as f32 / BONE_RING_SEGMENTS as f32;
        let (sin, cos) = angle.sin_cos();
        let current = center + (axis_a * cos + axis_b * sin) * radius;
        draw_bone_line(window, previous, current, color, BONE_RING_WIDTH);
        previous = current;
    }
}

fn draw_bone_line(window: &mut Window, start: Vec3, end: Vec3, color: Color, width: f32) {
    if start.is_finite() && end.is_finite() {
        window.draw_line_with_depth_bias(start, end, color, width, false, BONE_OVERLAY_DEPTH_BIAS);
    }
}

fn bone_local_basis(node: &SceneNode3d, origin: Vec3) -> [Vec3; 3] {
    let world = node.world_matrix();
    let raw_x = world.transform_point3(Vec3::X) - origin;
    let local_x = unit_or(raw_x, Vec3::X);
    let raw_y = world.transform_point3(Vec3::Y) - origin;
    let local_y = unit_or(
        raw_y - local_x * local_x.dot(raw_y),
        perpendicular_to(local_x),
    );
    let mut local_z = unit_or(local_x.cross(local_y), Vec3::Z);
    let raw_z = world.transform_point3(Vec3::Z) - origin;
    if raw_z.is_finite() && raw_z.length_squared() > BONE_EPSILON && raw_z.dot(local_z) < 0.0 {
        local_z = -local_z;
    }
    [local_x, local_y, local_z]
}

fn bone_joint_radius() -> f32 {
    BONE_JOINT_RADIUS
}

fn bone_pyramid_half_width() -> f32 {
    bone_joint_radius() / std::f32::consts::SQRT_2
}

fn unit_or(value: Vec3, fallback: Vec3) -> Vec3 {
    if value.is_finite() && value.length_squared() > BONE_EPSILON {
        value.normalize()
    } else {
        fallback
    }
}

fn perpendicular_to(direction: Vec3) -> Vec3 {
    let reference = if direction.y.abs() < 0.9 {
        Vec3::Y
    } else {
        Vec3::X
    };
    unit_or(reference - direction * direction.dot(reference), Vec3::Z)
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

fn runtime_bone_id(instance_id: &str, source_index: usize) -> String {
    format!("{instance_id}::bone::{source_index}")
}

fn runtime_instance_summaries(instance: &RuntimeInstance) -> Vec<SceneNodeSummary> {
    let visible = instance.root.is_visible();
    let mut nodes = vec![SceneNodeSummary {
        id: instance.id.clone(),
        parent: Some(SCENE_ID.to_string()),
        label: instance.id.clone(),
        kind: "mesh".to_string(),
        visible,
    }];
    nodes.extend(instance.bones.iter().map(|bone| {
        SceneNodeSummary {
            id: runtime_bone_id(&instance.id, bone.source_index),
            parent: bone
                .parent_source_index
                .map(|parent| runtime_bone_id(&instance.id, parent))
                .or_else(|| Some(instance.id.clone())),
            label: bone.label.clone(),
            kind: "bone".to_string(),
            visible,
        }
    }));
    nodes
}

impl Renderer {
    fn runtime_bone(&self, node_id: &str) -> Option<&RuntimeBone> {
        for instance in &self.instances {
            if let Some(bone) = instance
                .bones
                .iter()
                .find(|bone| runtime_bone_id(&instance.id, bone.source_index) == node_id)
            {
                return Some(bone);
            }
        }
        None
    }

    fn runtime_bone_mut(&mut self, node_id: &str) -> Option<&mut RuntimeBone> {
        for instance in &mut self.instances {
            if let Some(bone) = instance
                .bones
                .iter_mut()
                .find(|bone| runtime_bone_id(&instance.id, bone.source_index) == node_id)
            {
                return Some(bone);
            }
        }
        None
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
    fn bone_local_basis_is_orthonormal_for_identity_node() {
        let node = SceneNode3d::empty();
        let [x, y, z] = bone_local_basis(&node, Vec3::ZERO);

        assert!((x.dot(Vec3::X) - 1.0).abs() < 1e-5);
        assert!((y.dot(Vec3::Y) - 1.0).abs() < 1e-5);
        assert!((z.dot(Vec3::Z) - 1.0).abs() < 1e-5);
        assert!(x.dot(y).abs() < 1e-5);
        assert!(y.dot(z).abs() < 1e-5);
        assert!(z.dot(x).abs() < 1e-5);
    }

    #[test]
    fn bone_perpendicular_to_axis_handles_vertical_bones() {
        let perpendicular = perpendicular_to(Vec3::Y);

        assert!(perpendicular.is_finite());
        assert!(perpendicular.dot(Vec3::Y).abs() < 1e-5);
        assert!((perpendicular.length() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn bone_pyramid_side_is_fixed_to_sphere_diameter_over_sqrt_two() {
        let sphere_diameter = bone_joint_radius() * 2.0;
        let side = bone_pyramid_half_width() * 2.0;

        assert!((side - sphere_diameter / std::f32::consts::SQRT_2).abs() < 1e-6);
        assert_eq!(bone_joint_radius(), BONE_JOINT_RADIUS);
    }

    #[test]
    fn bone_local_axis_stays_inside_joint_sphere() {
        let axis_length = bone_joint_radius() * BONE_AXIS_LENGTH_FACTOR;

        assert!(axis_length <= bone_joint_radius());
        assert!(axis_length > 0.0);
    }

    #[test]
    fn runtime_projection_summary_uses_instance_id_without_cube() {
        let mut root = SceneNode3d::empty();
        root.set_visible(false);
        let summaries = runtime_instance_summaries(&RuntimeInstance {
            id: "box-instance".to_string(),
            root,
            player: AnimationPlayer::new(Vec::new()),
            bone_edges: Vec::new(),
            bones: Vec::new(),
        });
        let summary = &summaries[0];
        assert_eq!(summary.id, "box-instance");
        assert_eq!(summary.label, "box-instance");
        assert_eq!(summary.parent.as_deref(), Some(SCENE_ID));
        assert!(!summary.visible);
    }

    #[test]
    fn runtime_projection_summary_nests_bones_under_the_instance_and_each_parent() {
        let mut root = SceneNode3d::empty();
        root.set_visible(true);
        let summaries = runtime_instance_summaries(&RuntimeInstance {
            id: "character".to_string(),
            root,
            player: AnimationPlayer::new(Vec::new()),
            bone_edges: Vec::new(),
            bones: vec![
                RuntimeBone {
                    source_index: 4,
                    parent_source_index: None,
                    label: "Root".to_string(),
                    node: SceneNode3d::empty(),
                },
                RuntimeBone {
                    source_index: 9,
                    parent_source_index: Some(4),
                    label: "Spine".to_string(),
                    node: SceneNode3d::empty(),
                },
            ],
        });

        assert_eq!(summaries[1].id, "character::bone::4");
        assert_eq!(summaries[1].parent.as_deref(), Some("character"));
        assert_eq!(summaries[1].kind, "bone");
        assert_eq!(summaries[2].id, "character::bone::9");
        assert_eq!(summaries[2].parent.as_deref(), Some("character::bone::4"));
    }

    #[test]
    fn runtime_instance_classifier_excludes_builtins_and_bones() {
        let instances = vec![
            RuntimeInstance {
                id: "character".to_string(),
                root: SceneNode3d::empty(),
                player: AnimationPlayer::new(Vec::new()),
                bone_edges: Vec::new(),
                bones: vec![RuntimeBone {
                    source_index: 4,
                    parent_source_index: None,
                    label: "Root".to_string(),
                    node: SceneNode3d::empty(),
                }],
            },
            RuntimeInstance {
                id: CUBE_ID.to_string(),
                root: SceneNode3d::empty(),
                player: AnimationPlayer::new(Vec::new()),
                bone_edges: Vec::new(),
                bones: Vec::new(),
            },
        ];

        assert!(is_runtime_instance_id(&instances, "character"));
        assert!(!is_runtime_instance_id(&instances, "character::bone::4"));
        assert!(!is_runtime_instance_id(&instances, SCENE_ID));
        assert!(!is_runtime_instance_id(&instances, KEY_LIGHT_ID));
        assert!(!is_runtime_instance_id(&instances, CUBE_ID));
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

    #[test]
    fn surface_status_fault_injection_is_opt_in_and_excludes_oom() {
        assert_eq!(
            parse_surface_status_self_test("timeout"),
            Some(RenderFrameStatus::Skipped(SurfaceSkipReason::Timeout))
        );
        assert_eq!(
            parse_surface_status_self_test("occluded"),
            Some(RenderFrameStatus::Skipped(SurfaceSkipReason::Occluded))
        );
        assert_eq!(
            parse_surface_status_self_test("lost"),
            Some(RenderFrameStatus::SurfaceUnavailable(
                SurfaceUnavailableReason::Lost
            ))
        );
        assert_eq!(
            parse_surface_status_self_test("validation"),
            Some(RenderFrameStatus::SurfaceUnavailable(
                SurfaceUnavailableReason::Validation
            ))
        );
        assert_eq!(
            parse_surface_status_self_test("missing-surface"),
            Some(RenderFrameStatus::SurfaceUnavailable(
                SurfaceUnavailableReason::MissingSurface
            ))
        );
        assert_eq!(parse_surface_status_self_test("oom"), None);
        assert_eq!(parse_surface_status_self_test(""), None);
    }
}

pub fn apply_viewport_rect(renderer: &mut Renderer, rect: ViewportRect) {
    renderer.set_viewport_rect(rect);
}
