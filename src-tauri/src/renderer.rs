use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use glam::Vec2;
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
    CameraProjection, CameraSettings, CameraState, ManipulatorMode, ManipulatorOrientation,
    ManipulatorSnapSettings, ViewportBackgroundMode, ViewportDisplayMode, ViewportDisplaySettings,
    ViewportEnvironmentSettings, ViewportLightingSettings, ViewportRect, ViewportTonemap,
};
use crate::scene::{diagnostic_path, diagnostic_text, ResolvedAssetPath, Scene, SceneInstance};
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
const X_AXIS_COLOR: Color = Color::new(1.00, 0.08, 0.08, 1.0);
const Y_AXIS_COLOR: Color = Color::new(0.12, 1.00, 0.12, 1.0);
const Z_AXIS_COLOR: Color = Color::new(0.12, 0.38, 1.00, 1.0);
const BONE_COLOR: Color = Color::new(1.0, 0.65, 0.15, 1.0);
const BONE_OVERLAY_DEPTH_BIAS: f32 = 0.995;
const BONE_RING_SEGMENTS: usize = 16;
static BONE_RING_UNIT_POINTS: OnceLock<Vec<(f32, f32)>> = OnceLock::new();
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
const MANIPULATOR_LENGTH_CSS_PX: f32 = 72.0;
const MANIPULATOR_RING_RADIUS_CSS_PX: f32 = 62.0;
const MANIPULATOR_OUTER_RING_RADIUS_CSS_PX: f32 = 82.0;
const MANIPULATOR_HIT_RADIUS_CSS_PX: f32 = 10.0;
const MANIPULATOR_RING_SEGMENTS: usize = 48;
const MANIPULATOR_SHAFT_WIDTH_PX: f32 = 1.25;
const MANIPULATOR_DETAIL_WIDTH_PX: f32 = 1.0;
const MANIPULATOR_CONE_BASE_CSS_PX: f32 = 8.0;
const MANIPULATOR_CONE_DEPTH_CSS_PX: f32 = 14.0;
const MANIPULATOR_PLANE_OFFSET_CSS_PX: f32 = 24.0;
const MANIPULATOR_PLANE_HALF_SIZE_CSS_PX: f32 = 10.0;
const MANIPULATOR_CENTER_RADIUS_CSS_PX: f32 = 9.0;
const MANIPULATOR_MARKER_CUBE_CSS_PX: f32 = 11.0;
const MANIPULATOR_CONE_RIBS: usize = 12;
const MAX_BONES_PER_INSTANCE: usize = 65_536;
const MAX_BONE_DEPTH: usize = 512;
// Loading the same source once per instance is currently required by the
// vendor loader.  Keep this bounded until immutable asset templates can share
// decoded meshes/textures across independent instance graphs.
const MAX_RUNTIME_INSTANCES_PER_ASSET: usize = 64;
const MAX_RUNTIME_LABEL_BYTES: usize = 1024;
const MAX_RUNTIME_SCENE_NODES: usize = 262_144;
const STATIC_RUNTIME_SCENE_NODES: usize = 2;
const MAX_RUNTIME_PROJECTION_TEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_SOURCE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_GLTF_JSON_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GLTF_IMAGES: usize = 256;
const MAX_GLTF_ACCESSOR_ELEMENTS: u64 = 100_000_000;
const MAX_GLTF_NODES: usize = MAX_RUNTIME_SCENE_NODES;
const MAX_GLTF_SKINS: usize = MAX_BONES_PER_INSTANCE;
const MAX_GLTF_SKIN_JOINT_REFERENCES: usize = MAX_RUNTIME_SCENE_NODES;
const MAX_GLTF_MESHES: usize = MAX_RUNTIME_SCENE_NODES;
const MAX_GLTF_PRIMITIVES: usize = MAX_RUNTIME_SCENE_NODES;
const MAX_GLTF_MATERIALS: usize = MAX_RUNTIME_SCENE_NODES;
// The vendor loader materializes every animation and channel into CPU vectors
// before the timeline projection is built. Keep its runtime path aligned with
// the metadata budget so a direct renderer load cannot bypass those limits.
const MAX_GLTF_ANIMATIONS: usize = 64;
const MAX_GLTF_ANIMATION_CHANNELS: usize = 65_536;
const MAX_GLTF_ANIMATION_KEY_VALUES: usize = 1_000_000;

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
    AssetInstanceLimit {
        asset_id: String,
        path: String,
        instances: usize,
        limit: usize,
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
                "Scene instance '{}' references asset '{}' without a resolved path",
                diagnostic_text(instance_id),
                diagnostic_text(asset_id),
            ),
            Self::AssetInstanceLimit {
                asset_id,
                path,
                instances,
                limit,
            } => write!(
                formatter,
                "Scene asset '{}' at {} is referenced by {instances} instances; maximum is {limit}",
                diagnostic_text(asset_id),
                diagnostic_text(path),
            ),
            Self::AssetLoad {
                instance_id,
                asset_id,
                path,
                message,
            } => write!(
                formatter,
                "failed to load Scene instance '{}' asset '{}' at {}: {}",
                diagnostic_text(instance_id),
                diagnostic_text(asset_id),
                diagnostic_text(path),
                diagnostic_text(message),
            ),
            Self::InvalidInstanceTransform {
                instance_id,
                message,
            } => write!(
                formatter,
                "invalid transform for Scene instance '{}': {}",
                diagnostic_text(instance_id),
                diagnostic_text(message),
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

#[derive(Clone, Copy)]
struct ProjectedManipulatorAxis {
    index: usize,
    world_axis: Vec3,
    screen_direction: Vec2,
    pixels_per_world_unit: f32,
}

struct ProjectedRotationRing {
    index: usize,
    world_axis: Vec3,
    world_points: Vec<Vec3>,
    screen_points: Vec<Vec2>,
    is_view: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManipulatorHandleKind {
    Axis(usize),
    Plane(usize, usize),
    Center,
    UniformScale,
    RotateAxis(usize),
    ViewRotate,
}

impl ManipulatorHandleKind {
    fn priority(self) -> u8 {
        match self {
            Self::Center | Self::UniformScale | Self::ViewRotate => 0,
            Self::Plane(_, _) => 1,
            Self::Axis(_) | Self::RotateAxis(_) => 2,
        }
    }
}

#[derive(Clone, Copy)]
struct ProjectedManipulatorPlane {
    world_axes: [Vec3; 2],
    screen_axes: [Vec2; 2],
    pixels_per_world_unit: [f32; 2],
}

#[derive(Clone)]
enum ManipulatorHitShape {
    Segment(Vec2, Vec2),
    Polygon(Vec<Vec2>),
    Circle { center: Vec2, radius: f32 },
    Polyline(Vec<Vec2>),
}

#[derive(Clone)]
struct ProjectedManipulatorHandle {
    kind: ManipulatorHandleKind,
    world_points: Vec<Vec3>,
    hit: ManipulatorHitShape,
    axis: Option<ProjectedManipulatorAxis>,
    plane: Option<ProjectedManipulatorPlane>,
}

#[derive(Clone, Copy)]
struct ManipulatorProjectionContext {
    camera: CameraState,
    settings: CameraSettings,
    rect: ViewportRect,
    world_units_per_css_px: f32,
}

#[derive(Clone)]
enum ManipulatorDrag {
    Translate {
        node_id: String,
        axis: ProjectedManipulatorAxis,
        start_pointer: Vec2,
        start_transform: SceneTransform,
        snap: bool,
        snap_increment: f32,
    },
    TranslatePlane {
        node_id: String,
        kind: ManipulatorHandleKind,
        plane: ProjectedManipulatorPlane,
        start_pointer: Vec2,
        start_transform: SceneTransform,
        snap: bool,
        snap_increment: f32,
    },
    Rotate {
        node_id: String,
        kind: ManipulatorHandleKind,
        world_axis: Vec3,
        rotation_center: Vec2,
        last_vector: Vec2,
        angle_sign: f32,
        accumulated_angle: f32,
        start_transform: SceneTransform,
        snap: bool,
        snap_increment: f32,
    },
    Scale {
        node_id: String,
        axis: ProjectedManipulatorAxis,
        start_pointer: Vec2,
        start_transform: SceneTransform,
        snap: bool,
        snap_increment: f32,
    },
    ScaleUniform {
        node_id: String,
        start_pointer: Vec2,
        screen_direction: Vec2,
        start_transform: SceneTransform,
        snap: bool,
        snap_increment: f32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ManipulatorViewSignature {
    camera_target: [f32; 3],
    camera_yaw: f32,
    camera_pitch: f32,
    camera_distance: f32,
    projection: CameraProjection,
    fov_degrees: f32,
    rect: ViewportRect,
}

impl ManipulatorViewSignature {
    fn new(camera: CameraState, settings: CameraSettings, rect: ViewportRect) -> Self {
        Self {
            camera_target: camera.target,
            camera_yaw: camera.yaw,
            camera_pitch: camera.pitch,
            camera_distance: camera.distance,
            projection: settings.projection,
            fov_degrees: settings.fov_degrees,
            rect,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ManipulatorMaterialSignature {
    color: [f32; 4],
    metallic: f32,
    roughness: f32,
}

#[derive(Clone, Debug, PartialEq)]
struct ManipulatorNodeSignature {
    transform: SceneTransform,
    visible: bool,
    scene_visible: bool,
    transform_editable: bool,
    material: Option<ManipulatorMaterialSignature>,
}

#[derive(Clone, Debug, PartialEq)]
struct ManipulatorViewCacheKey {
    node_id: Option<String>,
    mode: ManipulatorMode,
    orientation: ManipulatorOrientation,
    signature: ManipulatorViewSignature,
    node: Option<ManipulatorNodeSignature>,
}

impl ManipulatorDrag {
    fn node_id(&self) -> &str {
        match self {
            Self::Translate { node_id, .. }
            | Self::TranslatePlane { node_id, .. }
            | Self::Rotate { node_id, .. }
            | Self::Scale { node_id, .. }
            | Self::ScaleUniform { node_id, .. } => node_id,
        }
    }

    fn mode(&self) -> ManipulatorMode {
        match self {
            Self::Translate { .. } => ManipulatorMode::Translate,
            Self::TranslatePlane { .. } => ManipulatorMode::Translate,
            Self::Rotate { .. } => ManipulatorMode::Rotate,
            Self::Scale { .. } | Self::ScaleUniform { .. } => ManipulatorMode::Scale,
        }
    }

    fn start_pointer(&self) -> Vec2 {
        match self {
            Self::Translate { start_pointer, .. }
            | Self::TranslatePlane { start_pointer, .. }
            | Self::Scale { start_pointer, .. }
            | Self::ScaleUniform { start_pointer, .. } => *start_pointer,
            Self::Rotate {
                rotation_center,
                last_vector,
                ..
            } => *rotation_center + *last_vector,
        }
    }

    fn start_transform(&self) -> SceneTransform {
        match self {
            Self::Translate {
                start_transform, ..
            }
            | Self::TranslatePlane {
                start_transform, ..
            }
            | Self::Rotate {
                start_transform, ..
            }
            | Self::Scale {
                start_transform, ..
            }
            | Self::ScaleUniform {
                start_transform, ..
            } => start_transform.clone(),
        }
    }

    fn handle_kind(&self) -> ManipulatorHandleKind {
        match self {
            Self::Translate { axis, .. } | Self::Scale { axis, .. } => {
                ManipulatorHandleKind::Axis(axis.index)
            }
            Self::TranslatePlane { kind, .. } => *kind,
            Self::Rotate { kind, .. } => *kind,
            Self::ScaleUniform { .. } => ManipulatorHandleKind::UniformScale,
        }
    }
}

struct ManipulatorView {
    node_id: String,
    mode: ManipulatorMode,
    signature: ManipulatorViewSignature,
    origin: Vec3,
    screen_origin: Vec2,
    axes: Vec<ProjectedManipulatorAxis>,
    rings: Vec<ProjectedRotationRing>,
    handles: Vec<ProjectedManipulatorHandle>,
    world_units_per_css_px: f32,
    line_width: f32,
}

pub struct ManipulatorTransformUpdate {
    pub node_id: String,
    pub transform: SceneTransform,
}

pub struct ManipulatorInputOutcome {
    pub consumed: bool,
    pub update: Option<ManipulatorTransformUpdate>,
    pub rollback: Option<ManipulatorTransformUpdate>,
    pub commit: Option<ManipulatorTransformHistory>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ManipulatorTransformHistory {
    pub node_id: String,
    pub before: SceneTransform,
    pub after: SceneTransform,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransformHistoryRequest {
    Undo,
    Redo,
}

#[derive(Clone, Debug, PartialEq)]
struct TransformHistoryEntry {
    node_id: String,
    before: SceneTransform,
    after: SceneTransform,
}

const MAX_TRANSFORM_HISTORY: usize = 128;

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
    last_camera_state: Option<CameraState>,
    camera_settings: Option<CameraSettings>,
    display: ViewportDisplaySettings,
    lighting_settings: Option<ViewportLightingSettings>,
    environment_request: ViewportEnvironmentSettings,
    environment_active: ViewportEnvironmentSettings,
    performance_target: Option<(u32, u32)>,
    performance_sampler: Option<PerformanceSampler>,
    animation_clock: Instant,
    surface_status_injection: Option<RenderFrameStatus>,
    timeline_playback_target: Option<(String, usize)>,
    manipulator_view: Option<ManipulatorView>,
    manipulator_view_cache: Option<ManipulatorViewCacheKey>,
    manipulator_drag: Option<ManipulatorDrag>,
    manipulator_hover: Option<ManipulatorHandleKind>,
    manipulator_orientation: ManipulatorOrientation,
    manipulator_snap: ManipulatorSnapSettings,
    transform_history: Vec<TransformHistoryEntry>,
    transform_history_cursor: usize,
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
            last_camera_state: None,
            camera_settings: None,
            display: ViewportDisplaySettings::default(),
            lighting_settings: None,
            environment_request: ViewportEnvironmentSettings::default(),
            environment_active: ViewportEnvironmentSettings::default(),
            performance_target,
            performance_sampler: PerformanceSampler::from_env(),
            animation_clock: Instant::now(),
            surface_status_injection: surface_status_self_test_from_env(),
            timeline_playback_target: None,
            manipulator_view: None,
            manipulator_view_cache: None,
            manipulator_drag: None,
            manipulator_hover: None,
            manipulator_orientation: ManipulatorOrientation::World,
            manipulator_snap: ManipulatorSnapSettings::default(),
            transform_history: Vec::new(),
            transform_history_cursor: 0,
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
        let timeline_playback_target = first_timeline_playback_target(&runtime.instances);
        Ok(Renderer {
            window: kiss_window,
            scene: runtime.scene,
            key_light: runtime.key_light,
            cube: runtime.cube,
            instances: runtime.instances,
            scene_label: runtime.scene_label,
            default_node_id: runtime.default_node_id,
            camera: OrbitCamera3d::new(Vec3::new(3.0, 1.5, -3.0), Vec3::ZERO),
            last_camera_state: None,
            camera_settings: None,
            display: ViewportDisplaySettings::default(),
            lighting_settings: None,
            environment_request: ViewportEnvironmentSettings::default(),
            environment_active: ViewportEnvironmentSettings::default(),
            performance_target,
            performance_sampler: PerformanceSampler::from_env(),
            animation_clock: Instant::now(),
            surface_status_injection: surface_status_self_test_from_env(),
            timeline_playback_target,
            manipulator_view: None,
            manipulator_view_cache: None,
            manipulator_drag: None,
            manipulator_hover: None,
            manipulator_orientation: ManipulatorOrientation::World,
            manipulator_snap: ManipulatorSnapSettings::default(),
            transform_history: Vec::new(),
            transform_history_cursor: 0,
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
        let timeline_playback_target = first_timeline_playback_target(&runtime.instances);
        self.scene = runtime.scene;
        self.key_light = runtime.key_light;
        self.cube = runtime.cube;
        self.instances = runtime.instances;
        self.scene_label = runtime.scene_label;
        self.default_node_id = runtime.default_node_id;
        self.timeline_playback_target = timeline_playback_target;
        self.animation_clock = Instant::now();
        self.manipulator_view = None;
        self.manipulator_view_cache = None;
        self.manipulator_drag = None;
        self.manipulator_hover = None;
        self.clear_transform_history();
        self.apply_display_mode(self.display.mode);
        Ok(())
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.window.canvas_mut().resize(width, height);
        }
    }

    pub fn set_camera_state(&mut self, state: CameraState) {
        if self
            .last_camera_state
            .is_some_and(|previous| camera_state_equal(previous, state))
        {
            return;
        }
        let target = Vec3::from_array(state.target);
        let (sin_yaw, cos_yaw) = state.yaw.sin_cos();
        let (sin_pitch, cos_pitch) = state.pitch.sin_cos();
        let eye = target
            + state.distance * Vec3::new(cos_pitch * cos_yaw, sin_pitch, cos_pitch * sin_yaw);
        self.camera.look_at(eye, target);
        self.last_camera_state = Some(state);
    }

    /// Apply editor-only projection/FOV settings to the Native camera. The
    /// orbit pose remains owned by `CameraState`; changing these values never
    /// alters target, yaw, pitch, or distance.
    pub fn set_camera_settings(&mut self, settings: CameraSettings) {
        if self.camera_settings == Some(settings) {
            return;
        }
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
        self.camera_settings = Some(settings);
    }

    pub fn set_viewport_rect(&mut self, rect: ViewportRect) {
        let viewport = self
            .performance_target
            .map(|(width, height)| RenderViewport::new(0, 0, width, height))
            .unwrap_or_else(|| viewport_rect_to_physical(rect));
        self.window.set_render_viewport(Some(viewport));
    }

    pub fn update_manipulator_view(
        &mut self,
        selected_id: Option<&str>,
        mode: ManipulatorMode,
        orientation: ManipulatorOrientation,
        camera: CameraState,
        settings: CameraSettings,
        rect: ViewportRect,
    ) {
        let signature = ManipulatorViewSignature::new(camera, settings, rect);
        let node_signature =
            selected_id.and_then(|node_id| self.manipulator_node_signature(node_id));
        if self.manipulator_view_cache.as_ref().is_some_and(|cache| {
            cache_matches(
                cache,
                selected_id,
                mode,
                orientation,
                signature,
                node_signature.as_ref(),
            )
        }) {
            return;
        }
        let view_changed = self
            .manipulator_view
            .as_ref()
            .is_some_and(|view| view.signature != signature);
        self.manipulator_view_cache = Some(ManipulatorViewCacheKey {
            node_id: selected_id.map(ToOwned::to_owned),
            mode,
            orientation,
            signature,
            node: node_signature.clone(),
        });
        self.manipulator_view = selected_id.and_then(|node_id| {
            let node = node_signature.as_ref()?;
            if !node.transform_editable
                || !manipulator_effective_visibility(node.scene_visible, node.visible)
            {
                return None;
            }
            let origin = Vec3::from_array(node.transform.translation);
            let (screen_origin, axes) = projected_manipulator_axes(
                origin,
                node.transform.clone(),
                orientation,
                camera,
                settings,
                rect,
            )?;
            let world_units_per_css_px =
                manipulator_world_units_per_css_px(origin, camera, settings, rect)?;
            let rings = if mode == ManipulatorMode::Rotate {
                let mut rings = projected_rotation_rings(
                    origin,
                    screen_origin,
                    &axes,
                    world_units_per_css_px,
                    camera,
                    settings,
                    rect,
                );
                if let Some(view_ring) = projected_view_rotation_ring(
                    origin,
                    world_units_per_css_px,
                    camera,
                    settings,
                    rect,
                ) {
                    rings.push(view_ring);
                }
                rings
            } else {
                Vec::new()
            };
            let handles = projected_manipulator_handles(
                mode,
                origin,
                screen_origin,
                &axes,
                &rings,
                ManipulatorProjectionContext {
                    camera,
                    settings,
                    rect,
                    world_units_per_css_px,
                },
            );
            if (mode == ManipulatorMode::Rotate && rings.is_empty())
                || (mode != ManipulatorMode::Rotate && handles.is_empty())
            {
                return None;
            }
            Some(ManipulatorView {
                node_id: node_id.to_string(),
                mode,
                signature,
                origin,
                screen_origin,
                axes,
                rings,
                handles,
                world_units_per_css_px,
                line_width: 1.25 * rect.scale_factor.max(1.0),
            })
        });
        if view_changed {
            // Pointer deltas are interpreted in the projected basis captured
            // at pointer-down. Camera/FOV/viewport changes invalidate that
            // basis; a normal transform update does not change this signature
            // and therefore keeps the current drag continuous.
            self.manipulator_drag = None;
            self.manipulator_hover = None;
        }
        if self.manipulator_drag.as_ref().is_some_and(|drag| {
            self.manipulator_view
                .as_ref()
                .is_none_or(|view| view.node_id != drag.node_id() || view.mode != drag.mode())
        }) {
            self.manipulator_drag = None;
        }
    }

    pub fn clear_manipulator_view(&mut self) {
        self.manipulator_view = None;
        self.manipulator_view_cache = None;
        self.manipulator_drag = None;
    }

    /// End an in-progress drag while retaining the projected manipulator for
    /// the next Native gesture. Backend deactivation uses this instead of
    /// clearing the whole view, so reactivation can redraw immediately.
    pub fn cancel_manipulator_drag(&mut self) -> Option<ManipulatorTransformUpdate> {
        self.manipulator_drag
            .take()
            .map(|drag| ManipulatorTransformUpdate {
                node_id: drag.node_id().to_string(),
                transform: drag.start_transform(),
            })
    }

    pub fn set_manipulator_orientation(&mut self, orientation: ManipulatorOrientation) {
        if self.manipulator_orientation != orientation {
            self.manipulator_orientation = orientation;
            self.manipulator_view_cache = None;
        }
    }

    pub fn set_manipulator_snap(&mut self, settings: ManipulatorSnapSettings) {
        if self.manipulator_snap != settings {
            self.manipulator_snap = settings;
        }
    }

    pub fn clear_transform_history(&mut self) {
        self.transform_history.clear();
        self.transform_history_cursor = 0;
    }

    pub fn editable_transform(&self, node_id: &str) -> Option<SceneTransform> {
        self.manipulator_node_signature(node_id)
            .filter(|node| node.transform_editable)
            .map(|node| node.transform)
    }

    pub fn record_transform_history(
        &mut self,
        node_id: String,
        before: SceneTransform,
        after: SceneTransform,
    ) {
        if before == after {
            return;
        }
        self.transform_history
            .truncate(self.transform_history_cursor);
        self.transform_history.push(TransformHistoryEntry {
            node_id,
            before,
            after,
        });
        if self.transform_history.len() > MAX_TRANSFORM_HISTORY {
            let excess = self.transform_history.len() - MAX_TRANSFORM_HISTORY;
            self.transform_history.drain(..excess);
        }
        self.transform_history_cursor = self.transform_history.len();
    }

    pub fn take_transform_history(
        &self,
        request: TransformHistoryRequest,
    ) -> Option<ManipulatorTransformHistory> {
        let index = match request {
            TransformHistoryRequest::Undo => self.transform_history_cursor.checked_sub(1)?,
            TransformHistoryRequest::Redo => (self.transform_history_cursor
                < self.transform_history.len())
            .then_some(self.transform_history_cursor)?,
        };
        let entry = self.transform_history.get(index)?;
        Some(ManipulatorTransformHistory {
            node_id: entry.node_id.clone(),
            before: entry.before.clone(),
            after: entry.after.clone(),
        })
    }

    pub fn finish_transform_history(&mut self, request: TransformHistoryRequest) {
        match request {
            TransformHistoryRequest::Undo => {
                self.transform_history_cursor = self.transform_history_cursor.saturating_sub(1)
            }
            TransformHistoryRequest::Redo => {
                self.transform_history_cursor =
                    (self.transform_history_cursor + 1).min(self.transform_history.len())
            }
        }
    }

    pub fn handle_manipulator_input(
        &mut self,
        input: crate::protocol::ViewportInput,
    ) -> ManipulatorInputOutcome {
        use crate::protocol::ViewportInput;

        match input {
            ViewportInput::PointerDown {
                x,
                y,
                button: 0,
                modifiers,
            } => {
                let Some(view) = self.manipulator_view.as_ref() else {
                    return ManipulatorInputOutcome {
                        consumed: false,
                        update: None,
                        rollback: None,
                        commit: None,
                    };
                };
                let Some(selected) = self.selected_details(&view.node_id) else {
                    return ManipulatorInputOutcome {
                        consumed: false,
                        update: None,
                        rollback: None,
                        commit: None,
                    };
                };
                let pointer = Vec2::new(x, y);
                let snap_settings = self.manipulator_snap;
                let snap = snap_settings.enabled || modifiers & 1 != 0;
                let Some(handle) = pick_manipulator_handle(view, pointer) else {
                    return ManipulatorInputOutcome {
                        consumed: false,
                        update: None,
                        rollback: None,
                        commit: None,
                    };
                };
                self.manipulator_hover = Some(handle.kind);
                let drag = match view.mode {
                    ManipulatorMode::Translate => match handle.kind {
                        ManipulatorHandleKind::Axis(_) => ManipulatorDrag::Translate {
                            node_id: view.node_id.clone(),
                            axis: handle.axis.expect("axis handle carries projected axis"),
                            start_pointer: pointer,
                            start_transform: selected.transform,
                            snap,
                            snap_increment: snap_settings.translate_increment,
                        },
                        ManipulatorHandleKind::Plane(_, _) | ManipulatorHandleKind::Center => {
                            ManipulatorDrag::TranslatePlane {
                                node_id: view.node_id.clone(),
                                kind: handle.kind,
                                plane: handle.plane.expect("plane handle carries basis"),
                                start_pointer: pointer,
                                start_transform: selected.transform,
                                snap,
                                snap_increment: snap_settings.translate_increment,
                            }
                        }
                        _ => {
                            return ManipulatorInputOutcome {
                                consumed: false,
                                update: None,
                                rollback: None,
                                commit: None,
                            }
                        }
                    },
                    ManipulatorMode::Scale => match handle.kind {
                        ManipulatorHandleKind::Axis(_) => ManipulatorDrag::Scale {
                            node_id: view.node_id.clone(),
                            axis: handle.axis.expect("axis handle carries projected axis"),
                            start_pointer: pointer,
                            start_transform: selected.transform,
                            snap,
                            snap_increment: snap_settings.scale_increment,
                        },
                        ManipulatorHandleKind::UniformScale => ManipulatorDrag::ScaleUniform {
                            node_id: view.node_id.clone(),
                            start_pointer: pointer,
                            screen_direction: unit_or_2d(pointer - view.screen_origin, Vec2::Y),
                            start_transform: selected.transform,
                            snap,
                            snap_increment: snap_settings.scale_increment,
                        },
                        _ => {
                            return ManipulatorInputOutcome {
                                consumed: false,
                                update: None,
                                rollback: None,
                                commit: None,
                            }
                        }
                    },
                    ManipulatorMode::Rotate => {
                        let hit = view
                            .rings
                            .iter()
                            .filter(|ring| {
                                let kind = if ring.is_view {
                                    ManipulatorHandleKind::ViewRotate
                                } else {
                                    ManipulatorHandleKind::RotateAxis(ring.index)
                                };
                                kind == handle.kind
                            })
                            .filter_map(|ring| {
                                nearest_polyline_hit(pointer, &ring.screen_points)
                                    .map(|(distance, tangent)| (distance, ring, tangent))
                            })
                            .min_by(|left, right| left.0.total_cmp(&right.0));
                        let Some((_, ring, screen_tangent)) = hit else {
                            return ManipulatorInputOutcome {
                                consumed: false,
                                update: None,
                                rollback: None,
                                commit: None,
                            };
                        };
                        let start_vector = pointer - view.screen_origin;
                        let angle_sign =
                            rotation_drag_angle_sign(start_vector, screen_tangent, ring.is_view);
                        ManipulatorDrag::Rotate {
                            node_id: view.node_id.clone(),
                            kind: handle.kind,
                            world_axis: ring.world_axis,
                            rotation_center: view.screen_origin,
                            last_vector: start_vector,
                            angle_sign,
                            accumulated_angle: 0.0,
                            start_transform: selected.transform,
                            snap,
                            snap_increment: snap_settings.rotate_degrees.to_radians(),
                        }
                    }
                };
                self.manipulator_drag = Some(drag);
                ManipulatorInputOutcome {
                    consumed: true,
                    update: None,
                    rollback: None,
                    commit: None,
                }
            }
            ViewportInput::PointerMove { x, y, buttons, .. } => {
                if buttons & 1 == 0 {
                    if self.manipulator_drag.is_some() {
                        // WebView2 can report a release-state move immediately
                        // before PointerUp. Keep the gesture alive so PointerUp
                        // remains the sole commit boundary. Explicit
                        // PointerCancel/Escape still performs rollback.
                        return ManipulatorInputOutcome {
                            consumed: true,
                            update: None,
                            rollback: None,
                            commit: None,
                        };
                    }
                    if let Some(view) = self.manipulator_view.as_ref() {
                        self.manipulator_hover = pick_manipulator_handle(view, Vec2::new(x, y))
                            .map(|handle| handle.kind);
                    } else {
                        self.manipulator_hover = None;
                    }
                    return ManipulatorInputOutcome {
                        consumed: false,
                        update: None,
                        rollback: None,
                        commit: None,
                    };
                }
                let Some(drag) = self.manipulator_drag.as_mut() else {
                    return ManipulatorInputOutcome {
                        consumed: false,
                        update: None,
                        rollback: None,
                        commit: None,
                    };
                };
                let pointer = Vec2::new(x, y);
                if let ManipulatorDrag::Rotate {
                    rotation_center,
                    last_vector,
                    angle_sign,
                    accumulated_angle,
                    ..
                } = drag
                {
                    let current_vector = pointer - *rotation_center;
                    if let Some(delta) = signed_arc_angle(*last_vector, current_vector) {
                        *accumulated_angle += delta * *angle_sign;
                        *last_vector = current_vector;
                    }
                }
                let (node_id, transform) = manipulator_drag_transform(drag.clone(), pointer);
                ManipulatorInputOutcome {
                    consumed: true,
                    update: Some(ManipulatorTransformUpdate { node_id, transform }),
                    rollback: None,
                    commit: None,
                }
            }
            ViewportInput::PointerUp { .. } if self.manipulator_drag.is_some() => {
                let drag = self.manipulator_drag.take().expect("drag checked above");
                let node_id = drag.node_id().to_string();
                let before = drag.start_transform();
                let after = self
                    .editable_transform(&node_id)
                    .unwrap_or_else(|| before.clone());
                ManipulatorInputOutcome {
                    consumed: true,
                    update: None,
                    rollback: None,
                    commit: Some(ManipulatorTransformHistory {
                        node_id,
                        before,
                        after,
                    }),
                }
            }
            ViewportInput::PointerCancel if self.manipulator_drag.is_some() => {
                let drag = self.manipulator_drag.take().expect("drag checked above");
                ManipulatorInputOutcome {
                    consumed: true,
                    update: None,
                    rollback: Some(ManipulatorTransformUpdate {
                        node_id: drag.node_id().to_string(),
                        transform: drag.start_transform(),
                    }),
                    commit: None,
                }
            }
            _ => ManipulatorInputOutcome {
                consumed: false,
                update: None,
                rollback: None,
                commit: None,
            },
        }
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
        if self.lighting_settings == Some(settings) {
            return;
        }
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
        self.lighting_settings = Some(settings);
    }

    /// Apply a validated editor-only equirectangular skybox/IBL request. A
    /// failed decode leaves the previously active environment untouched.
    pub fn set_viewport_environment(
        &mut self,
        settings: ViewportEnvironmentSettings,
        encoded: Option<&[u8]>,
    ) -> bool {
        if self.environment_request == settings {
            return true;
        }
        if !settings.enabled {
            self.window.clear_skybox();
            self.environment_request = settings.clone();
            self.environment_active = settings;
            return true;
        }

        let needs_load = !self.window.has_skybox() || self.environment_active.path != settings.path;
        if needs_load {
            let Some(bytes) = encoded else {
                eprintln!("[viewport-environment] validated HDRI bytes are unavailable");
                return false;
            };
            if !self.window.set_skybox_from_memory(bytes) {
                eprintln!(
                    "[viewport-environment] failed to apply decoded HDRI: {}",
                    diagnostic_path(Path::new(&settings.path))
                );
                return false;
            }
        }
        self.window
            .set_skybox_orientation(settings.rotation_degrees.to_radians(), settings.intensity);
        // Keep the request retryable when decode/upload failed above. Commit
        // it only after the new environment has been applied successfully.
        self.environment_request = settings.clone();
        self.environment_active = settings;
        true
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
        if self.display.show_grid {
            draw_reference_grid_and_axes(&mut self.window);
        }
        if self.display.show_bones {
            draw_bone_edges(&mut self.window, self.scene.is_visible(), &self.instances);
        }
        if let Some(view) = &self.manipulator_view {
            let colors = [X_AXIS_COLOR, Y_AXIS_COLOR, Z_AXIS_COLOR];
            let active = self
                .manipulator_drag
                .as_ref()
                .map(ManipulatorDrag::handle_kind);
            for handle in &view.handles {
                let highlighted =
                    self.manipulator_hover == Some(handle.kind) || active == Some(handle.kind);
                let base = match handle.kind {
                    ManipulatorHandleKind::ViewRotate => Color::new(1.0, 0.82, 0.08, 1.0),
                    ManipulatorHandleKind::Plane(first, second) => {
                        let a = colors[first.min(2)];
                        let b = colors[second.min(2)];
                        Color::new((a.r + b.r) * 0.5, (a.g + b.g) * 0.5, (a.b + b.b) * 0.5, 1.0)
                    }
                    ManipulatorHandleKind::Center | ManipulatorHandleKind::UniformScale => {
                        Color::new(0.95, 0.95, 0.95, 1.0)
                    }
                    ManipulatorHandleKind::RotateAxis(index)
                    | ManipulatorHandleKind::Axis(index) => colors[index.min(2)],
                };
                let color = if highlighted {
                    Color::new(1.0, 0.9, 0.15, 1.0)
                } else {
                    base
                };
                // `Window::draw_line_with_depth_bias` consumes physical
                // pixels. Keep every overlay stroke at a constant CSS size
                // under HighDPI just like the base manipulator line width.
                let width_scale = manipulator_width_scale(view.signature.rect.scale_factor);
                match handle.kind {
                    ManipulatorHandleKind::RotateAxis(_) | ManipulatorHandleKind::ViewRotate => {
                        for segment in handle.world_points.windows(2) {
                            self.window.draw_line_with_depth_bias(
                                segment[0],
                                segment[1],
                                color,
                                view.line_width,
                                false,
                                0.99,
                            );
                        }
                    }
                    ManipulatorHandleKind::Axis(index) => {
                        let axis = handle.axis.expect("axis handle carries projected axis");
                        let end = *handle.world_points.last().expect("axis endpoint");
                        if view.mode == ManipulatorMode::Translate {
                            let cone_depth =
                                MANIPULATOR_CONE_DEPTH_CSS_PX * view.world_units_per_css_px;
                            let shaft_end = end - axis.world_axis * cone_depth;
                            self.window.draw_line_with_depth_bias(
                                view.origin,
                                shaft_end,
                                color,
                                manipulator_physical_width(
                                    MANIPULATOR_SHAFT_WIDTH_PX,
                                    view.signature.rect.scale_factor,
                                ),
                                false,
                                0.99,
                            );
                            draw_manipulator_cone(
                                &mut self.window,
                                end,
                                axis.world_axis,
                                view.world_units_per_css_px,
                                color,
                                width_scale,
                            );
                        } else {
                            self.window.draw_line_with_depth_bias(
                                view.origin,
                                end,
                                color,
                                manipulator_physical_width(
                                    MANIPULATOR_SHAFT_WIDTH_PX,
                                    view.signature.rect.scale_factor,
                                ),
                                false,
                                0.99,
                            );
                            let basis = [
                                view.axes
                                    .iter()
                                    .find(|candidate| candidate.index == 0)
                                    .map(|candidate| candidate.world_axis)
                                    .unwrap_or(Vec3::X),
                                view.axes
                                    .iter()
                                    .find(|candidate| candidate.index == 1)
                                    .map(|candidate| candidate.world_axis)
                                    .unwrap_or(Vec3::Y),
                                view.axes
                                    .iter()
                                    .find(|candidate| candidate.index == 2)
                                    .map(|candidate| candidate.world_axis)
                                    .unwrap_or(Vec3::Z),
                            ];
                            let half =
                                MANIPULATOR_MARKER_CUBE_CSS_PX * view.world_units_per_css_px * 0.5;
                            let marker = cube_marker_points(end, basis, half);
                            draw_manipulator_solid_cube(
                                &mut self.window,
                                &marker,
                                color,
                                view.line_width,
                            );
                        }
                        let _ = index;
                    }
                    ManipulatorHandleKind::Plane(_, _) => {
                        for segment in closed_polyline(&handle.world_points) {
                            self.window.draw_line_with_depth_bias(
                                segment.0,
                                segment.1,
                                color,
                                view.line_width,
                                false,
                                0.99,
                            );
                        }
                    }
                    ManipulatorHandleKind::Center => {
                        draw_manipulator_center_marker(
                            &mut self.window,
                            view.origin,
                            &handle.world_points,
                            color,
                            width_scale,
                        );
                    }
                    ManipulatorHandleKind::UniformScale => {
                        draw_manipulator_solid_cube(
                            &mut self.window,
                            &handle.world_points,
                            color,
                            view.line_width,
                        );
                    }
                }
            }
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
        {
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
        }
        self.timeline_playback_target = Some((instance_id.to_string(), clip_index));
        Ok(())
    }

    pub fn timeline_playback_snapshot(&self) -> TimelinePlaybackSnapshot {
        let Some((instance, clip_index)) = resolve_timeline_playback_target(
            &self.instances,
            self.timeline_playback_target.as_ref(),
        ) else {
            return TimelinePlaybackSnapshot::default();
        };
        TimelinePlaybackSnapshot {
            epoch: 0,
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
            command_results: Vec::new(),
        }
    }

    pub fn apply_scene_command(&mut self, command: SceneCommand) -> Result<(), String> {
        match command {
            SceneCommand::SetTransform { node_id, transform } => {
                let node = if node_id == CUBE_ID {
                    self.cube
                        .as_mut()
                        .ok_or_else(|| format!("unsupported scene node '{node_id}'"))?
                } else {
                    &mut self
                        .instances
                        .iter_mut()
                        .find(|instance| instance.id == node_id)
                        .ok_or_else(|| {
                            format!(
                                "scene node '{node_id}' does not have an editable object transform"
                            )
                        })?
                        .root
                };
                let rotation = Quat::from_array(transform.rotation).normalize();
                node.set_position(Vec3::from_array(transform.translation));
                node.set_rotation(rotation);
                node.set_local_scale(transform.scale[0], transform.scale[1], transform.scale[2]);
            }
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
        let runtime_node_count = self
            .instances
            .iter()
            .map(|instance| instance.bones.len().saturating_add(1))
            .sum::<usize>();
        nodes.reserve(runtime_node_count);
        for instance in &self.instances {
            append_runtime_instance_summaries(&mut nodes, instance);
        }

        let selected = selected_node_id
            .as_deref()
            .and_then(|id| self.selected_details(id));

        SceneProjection {
            // SceneProjectionStore stamps the active runtime epoch when this
            // renderer snapshot is published. Keep startup's explicit epoch
            // here for standalone snapshots and tests.
            epoch: 1,
            revision: 0,
            selected_node_id,
            nodes,
            selected,
            last_processed_sequence: 0,
            command_results: Vec::new(),
        }
    }

    fn selected_details(&self, node_id: &str) -> Option<SelectedSceneNode> {
        let node = self.scene_node(node_id)?;
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
            transform_editable: node_id == CUBE_ID || self.is_runtime_instance(node_id),
            material,
            light: project_light(node),
        })
    }

    fn scene_node(&self, node_id: &str) -> Option<&SceneNode3d> {
        match node_id {
            SCENE_ID => Some(&self.scene),
            KEY_LIGHT_ID => Some(&self.key_light),
            CUBE_ID => self.cube.as_ref(),
            _ => self
                .instances
                .iter()
                .find(|instance| instance.id == node_id)
                .map(|instance| &instance.root)
                .or_else(|| self.runtime_bone(node_id).map(|bone| &bone.node)),
        }
    }

    fn manipulator_node_signature(&self, node_id: &str) -> Option<ManipulatorNodeSignature> {
        let node = self.scene_node(node_id)?;
        let pose = node.local_transformation();
        let material = if node_id == CUBE_ID {
            let mut material = None;
            node.apply_to_object(&mut |object| {
                let data = object.data();
                let color = data.color();
                material = Some(ManipulatorMaterialSignature {
                    color: [color.r, color.g, color.b, color.a],
                    metallic: data.metallic(),
                    roughness: data.roughness(),
                });
            });
            material
        } else {
            None
        };
        Some(ManipulatorNodeSignature {
            transform: SceneTransform {
                translation: pose.translation.to_array(),
                rotation: pose.rotation.to_array(),
                scale: node.local_scale().to_array(),
            },
            visible: node.is_visible(),
            scene_visible: self.scene.is_visible(),
            transform_editable: node_id == CUBE_ID || self.is_runtime_instance(node_id),
            material,
        })
    }
}

fn cache_matches(
    cache: &ManipulatorViewCacheKey,
    selected_id: Option<&str>,
    mode: ManipulatorMode,
    orientation: ManipulatorOrientation,
    signature: ManipulatorViewSignature,
    node: Option<&ManipulatorNodeSignature>,
) -> bool {
    cache.node_id.as_deref() == selected_id
        && cache.mode == mode
        && cache.orientation == orientation
        && cache.signature == signature
        && cache.node.as_ref() == node
}

fn manipulator_effective_visibility(scene_visible: bool, node_visible: bool) -> bool {
    scene_visible && node_visible
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GltfBudgetUsage {
    declared_buffer_bytes: u64,
    external_resource_bytes: u64,
    image_count: usize,
    accessor_elements: u64,
    accessor_bytes: u64,
}

fn validate_asset_source_size(bytes: u64) -> Result<(), String> {
    if bytes > MAX_ASSET_SOURCE_BYTES {
        return Err(format!(
            "asset source is {bytes} bytes; limit is {MAX_ASSET_SOURCE_BYTES} bytes"
        ));
    }
    Ok(())
}

fn validate_gltf_budget(usage: GltfBudgetUsage) -> Result<(), String> {
    if usage.declared_buffer_bytes > MAX_ASSET_SOURCE_BYTES {
        return Err(format!(
            "glTF declares {} buffer bytes; limit is {MAX_ASSET_SOURCE_BYTES} bytes",
            usage.declared_buffer_bytes
        ));
    }
    if usage.external_resource_bytes > MAX_ASSET_SOURCE_BYTES {
        return Err(format!(
            "glTF external resources total {} bytes; limit is {MAX_ASSET_SOURCE_BYTES} bytes",
            usage.external_resource_bytes
        ));
    }
    if usage.image_count > MAX_GLTF_IMAGES {
        return Err(format!(
            "glTF contains {} images; limit is {MAX_GLTF_IMAGES}",
            usage.image_count
        ));
    }
    if usage.accessor_elements > MAX_GLTF_ACCESSOR_ELEMENTS {
        return Err(format!(
            "glTF declares {} accessor elements; limit is {MAX_GLTF_ACCESSOR_ELEMENTS}",
            usage.accessor_elements
        ));
    }
    if usage.accessor_bytes > MAX_ASSET_SOURCE_BYTES {
        return Err(format!(
            "glTF accessor expansion is {} bytes; limit is {MAX_ASSET_SOURCE_BYTES} bytes",
            usage.accessor_bytes
        ));
    }
    Ok(())
}

fn is_glb_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("glb"))
}

fn open_gltf_document(path: &Path) -> Result<gltf::Document, String> {
    if !is_glb_path(path) {
        let json_bytes = std::fs::metadata(path)
            .map_err(|error| {
                format!("glTF JSON document preflight failed to inspect file: {error}")
            })?
            .len();
        if json_bytes > MAX_GLTF_JSON_BYTES {
            return Err(format!(
                "glTF JSON document is {json_bytes} bytes; limit is {MAX_GLTF_JSON_BYTES} bytes"
            ));
        }
        return gltf::Gltf::open(path)
            .map(|gltf| gltf.document)
            .map_err(|error| format!("glTF document preflight failed: {error}"));
    }

    let mut file = File::open(path)
        .map_err(|error| format!("glB document preflight failed to open file: {error}"))?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| format!("glB document preflight failed to read header: {error}"))?;
    if &header[..4] != b"glTF" {
        return Err("glB document preflight found an invalid magic header".to_string());
    }
    if u32::from_le_bytes(header[4..8].try_into().unwrap()) != 2 {
        return Err("glB document preflight requires version 2".to_string());
    }
    let declared_length = u64::from(u32::from_le_bytes(header[8..12].try_into().unwrap()));
    validate_asset_source_size(declared_length)?;

    let mut chunk_header = [0u8; 8];
    file.read_exact(&mut chunk_header).map_err(|error| {
        format!("glB document preflight failed to read JSON chunk header: {error}")
    })?;
    if &chunk_header[4..] != b"JSON" {
        return Err("glB document preflight requires a JSON first chunk".to_string());
    }
    let json_length = u64::from(u32::from_le_bytes(chunk_header[..4].try_into().unwrap()));
    if json_length > MAX_GLTF_JSON_BYTES {
        return Err(format!(
            "glB JSON chunk is {json_length} bytes; limit is {MAX_GLTF_JSON_BYTES} bytes"
        ));
    }
    let json_length = usize::try_from(json_length)
        .map_err(|_| "glB JSON chunk length does not fit this platform".to_string())?;
    let mut json = vec![0u8; json_length];
    file.read_exact(&mut json)
        .map_err(|error| format!("glB document preflight failed to read JSON chunk: {error}"))?;
    gltf::Gltf::from_slice(&json)
        .map(|gltf| gltf.document)
        .map_err(|error| format!("glB document preflight failed: {error}"))
}

fn validate_gltf_document_budget_for_document(
    path: &Path,
    document: &gltf::Document,
) -> Result<(), String> {
    validate_gltf_node_count(document.nodes().count())?;
    validate_gltf_skin_count(document.skins().count())?;
    validate_gltf_skin_joint_references(document)?;
    validate_gltf_mesh_counts(document)?;
    validate_gltf_material_count(document.materials().count())?;
    validate_gltf_animation_counts(document)?;
    let declared_buffer_bytes = document.buffers().try_fold(0u64, |total, buffer| {
        let bytes = u64::try_from(buffer.length()).ok()?;
        total.checked_add(bytes)
    });
    let declared_buffer_bytes = declared_buffer_bytes
        .ok_or_else(|| "glTF declared buffer byte total overflowed".to_string())?;

    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let mut external_resource_bytes = 0u64;
    for buffer in document.buffers() {
        let gltf::buffer::Source::Uri(uri) = buffer.source() else {
            continue;
        };
        add_external_resource_size(
            &mut external_resource_bytes,
            resolve_gltf_local_uri(base, uri),
        )?;
    }
    for image in document.images() {
        let gltf::image::Source::Uri { uri, .. } = image.source() else {
            continue;
        };
        add_external_resource_size(
            &mut external_resource_bytes,
            resolve_gltf_local_uri(base, uri),
        )?;
    }

    let accessor_totals =
        document
            .accessors()
            .try_fold((0u64, 0u64), |(elements_total, bytes_total), accessor| {
                let elements = u64::try_from(accessor.count()).ok()?;
                let bytes_per_element = u64::try_from(accessor.size()).ok()?;
                let bytes = elements.checked_mul(bytes_per_element)?;
                Some((
                    elements_total.checked_add(elements)?,
                    bytes_total.checked_add(bytes)?,
                ))
            });
    let (accessor_elements, accessor_bytes) =
        accessor_totals.ok_or_else(|| "glTF accessor aggregate size overflowed".to_string())?;

    validate_gltf_budget(GltfBudgetUsage {
        declared_buffer_bytes,
        external_resource_bytes,
        image_count: document.images().count(),
        accessor_elements,
        accessor_bytes,
    })
}

fn validate_gltf_node_count(node_count: usize) -> Result<(), String> {
    if node_count > MAX_GLTF_NODES {
        return Err(format!(
            "glTF contains {node_count} nodes; limit is {MAX_GLTF_NODES}"
        ));
    }
    Ok(())
}

fn validate_gltf_skin_count(skin_count: usize) -> Result<(), String> {
    if skin_count > MAX_GLTF_SKINS {
        return Err(format!(
            "glTF contains {skin_count} skins; limit is {MAX_GLTF_SKINS}"
        ));
    }
    Ok(())
}

fn validate_gltf_skin_joint_references(document: &gltf::Document) -> Result<(), String> {
    let joint_references = document.nodes().try_fold(0usize, |total, node| {
        let references = node
            .mesh()
            .and_then(|_| node.skin())
            .map(|skin| skin.joints().count())
            .unwrap_or(0);
        total.checked_add(references)
    });
    let joint_references =
        joint_references.ok_or_else(|| "glTF skin joint reference count overflowed".to_string())?;
    validate_gltf_skin_joint_reference_values(joint_references)
}

fn validate_gltf_skin_joint_reference_values(joint_references: usize) -> Result<(), String> {
    if joint_references > MAX_GLTF_SKIN_JOINT_REFERENCES {
        return Err(format!(
            "glTF skinned node joint references total {joint_references}; limit is {MAX_GLTF_SKIN_JOINT_REFERENCES}"
        ));
    }
    Ok(())
}

fn validate_gltf_bone_count(bone_count: usize) -> Result<(), String> {
    if bone_count > MAX_BONES_PER_INSTANCE {
        return Err(format!(
            "glTF skeleton has {bone_count} bones; maximum is {MAX_BONES_PER_INSTANCE}"
        ));
    }
    Ok(())
}

fn validate_gltf_mesh_counts(document: &gltf::Document) -> Result<(), String> {
    let mesh_count = document.meshes().count();
    let primitive_count = document.meshes().try_fold(0usize, |total, mesh| {
        total.checked_add(mesh.primitives().count())
    });
    let primitive_count =
        primitive_count.ok_or_else(|| "glTF primitive count overflowed".to_string())?;
    validate_gltf_mesh_count_values(mesh_count, primitive_count)
}

fn validate_gltf_mesh_count_values(
    mesh_count: usize,
    primitive_count: usize,
) -> Result<(), String> {
    if mesh_count > MAX_GLTF_MESHES {
        return Err(format!(
            "glTF contains {mesh_count} meshes; limit is {MAX_GLTF_MESHES}"
        ));
    }
    if primitive_count > MAX_GLTF_PRIMITIVES {
        return Err(format!(
            "glTF contains {primitive_count} mesh primitives; limit is {MAX_GLTF_PRIMITIVES}"
        ));
    }
    Ok(())
}

fn validate_gltf_material_count(material_count: usize) -> Result<(), String> {
    if material_count > MAX_GLTF_MATERIALS {
        return Err(format!(
            "glTF contains {material_count} materials; limit is {MAX_GLTF_MATERIALS}"
        ));
    }
    Ok(())
}

fn validate_gltf_animation_counts(document: &gltf::Document) -> Result<(), String> {
    let animation_count = document.animations().count();
    let mut channel_count = 0usize;
    let mut input_values = 0usize;
    let mut output_values = 0usize;
    for animation in document.animations() {
        channel_count = channel_count
            .checked_add(animation.channels().count())
            .ok_or_else(|| "glTF animation channel count overflowed".to_string())?;
        for (channel_index, channel) in animation.channels().enumerate() {
            let channel_values = catch_unwind(AssertUnwindSafe(|| {
                let sampler = channel.sampler();
                let input_values = sampler.input().count();
                let output_values = sampler.output().count();
                validate_gltf_animation_channel_cardinality(
                    animation.index(),
                    channel_index,
                    &channel,
                    input_values,
                    output_values,
                )?;
                Ok::<(usize, usize), String>((input_values, output_values))
            }))
            .map_err(|_| {
                format!(
                    "glTF animation {} channel {channel_index} has an invalid sampler or accessor reference",
                    animation.index()
                )
            })??;
            input_values = input_values
                .checked_add(channel_values.0)
                .ok_or_else(|| "glTF animation key count overflowed".to_string())?;
            output_values = output_values
                .checked_add(channel_values.1)
                .ok_or_else(|| "glTF animation output count overflowed".to_string())?;
        }
    }
    validate_gltf_animation_count_values(animation_count, channel_count)?;
    validate_gltf_animation_key_values(input_values, output_values)
}

fn validate_gltf_animation_channel_cardinality(
    animation_index: usize,
    channel_index: usize,
    channel: &gltf::animation::Channel<'_>,
    key_count: usize,
    output_count: usize,
) -> Result<(), String> {
    let target = channel.target();
    let components_per_key = match target.property() {
        gltf::animation::Property::Translation
        | gltf::animation::Property::Rotation
        | gltf::animation::Property::Scale => 1,
        gltf::animation::Property::MorphTargetWeights => target
            .node()
            .mesh()
            .and_then(|mesh| {
                mesh.primitives()
                    .map(|primitive| primitive.morph_targets().len())
                    .max()
            })
            .filter(|count| *count > 0)
            .ok_or_else(|| {
                format!(
                    "glTF animation {animation_index} channel {channel_index} targets a node without morph targets"
                )
            })?,
    };
    let cubic_spline = matches!(
        channel.sampler().interpolation(),
        gltf::animation::Interpolation::CubicSpline
    );
    kiss3d::loader::gltf::validate_animation_output_cardinality(
        key_count,
        cubic_spline,
        output_count,
        components_per_key,
    )
    .map_err(|error| {
        format!(
            "glTF animation {animation_index} channel {channel_index} has invalid output cardinality: {error}"
        )
    })
}

fn validate_gltf_animation_count_values(
    animation_count: usize,
    channel_count: usize,
) -> Result<(), String> {
    if animation_count > MAX_GLTF_ANIMATIONS {
        return Err(format!(
            "glTF contains {animation_count} animations; limit is {MAX_GLTF_ANIMATIONS}"
        ));
    }
    if channel_count > MAX_GLTF_ANIMATION_CHANNELS {
        return Err(format!(
            "glTF contains {channel_count} animation channels; limit is {MAX_GLTF_ANIMATION_CHANNELS}"
        ));
    }
    Ok(())
}

fn validate_gltf_animation_key_values(
    input_values: usize,
    output_values: usize,
) -> Result<(), String> {
    if input_values > MAX_GLTF_ANIMATION_KEY_VALUES {
        return Err(format!(
            "glTF animation inputs contain {input_values} key values; limit is {MAX_GLTF_ANIMATION_KEY_VALUES}"
        ));
    }
    if output_values > MAX_GLTF_ANIMATION_KEY_VALUES {
        return Err(format!(
            "glTF animation outputs contain {output_values} values; limit is {MAX_GLTF_ANIMATION_KEY_VALUES}"
        ));
    }
    Ok(())
}

fn add_external_resource_size(total: &mut u64, path: Option<PathBuf>) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };
    let Ok(bytes) = std::fs::metadata(path).map(|metadata| metadata.len()) else {
        // Preserve the vendor loader's error for missing or unreadable external
        // resources; this preflight only rejects resources that are known to
        // exceed the aggregate budget.
        return Ok(());
    };
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| "glTF external resource byte total overflowed".to_string())?;
    if *total > MAX_ASSET_SOURCE_BYTES {
        return Err(format!(
            "glTF external resources total {} bytes; limit is {MAX_ASSET_SOURCE_BYTES} bytes",
            *total
        ));
    }
    Ok(())
}

/// Resolve only URI forms that the gltf importer reads from the local
/// filesystem. Data and unsupported/remote schemes remain the importer's
/// responsibility and are intentionally not reinterpreted by preflight.
fn resolve_gltf_local_uri(base: &Path, uri: &str) -> Option<PathBuf> {
    if uri.is_empty() || uri.starts_with("data:") {
        return None;
    }
    if let Some(path) = uri
        .strip_prefix("file://")
        .or_else(|| uri.strip_prefix("file:"))
    {
        let path = decode_uri_path(path)?;
        let path = PathBuf::from(path);
        return Some(if path.is_absolute() {
            path
        } else {
            std::env::current_dir().ok()?.join(path)
        });
    }
    if uri.contains(':') {
        return None;
    }
    Some(base.join(decode_uri_path(uri)?))
}

fn decode_uri_path(uri: &str) -> Option<String> {
    let bytes = uri.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).and_then(|value| hex_digit(*value))?;
            let low = bytes.get(index + 2).and_then(|value| hex_digit(*value))?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn validate_runtime_asset_source(path: &Path, kind: &str) -> Result<(), String> {
    validate_runtime_asset_source_with_projection(path, kind).map(|_| ())
}

fn validate_runtime_asset_source_with_projection(
    path: &Path,
    kind: &str,
) -> Result<Option<Vec<GltfProjectionBone>>, String> {
    let bytes = std::fs::metadata(path)
        .map_err(|error| format!("asset source metadata failed: {error}"))?
        .len();
    validate_asset_source_size(bytes)?;
    if kind != "gltf" {
        return Ok(None);
    }
    let document = open_gltf_document(path)?;
    validate_gltf_document_budget_for_document(path, &document)?;
    let projection_bones = gltf_projection_bones(&document);
    validate_gltf_bone_count(projection_bones.len())?;
    Ok(Some(projection_bones))
}

fn build_runtime_scene(
    scene_document: &Scene,
    resolved_assets: &[ResolvedAssetPath],
) -> Result<RuntimeScene, RendererError> {
    let mut scene = SceneNode3d::empty();
    let key_light = scene.add_light(Light::directional(Vec3::new(-0.45, -1.0, -0.35)));

    let mut assets_by_id = HashMap::with_capacity(scene_document.assets.len());
    for asset in &scene_document.assets {
        assets_by_id.entry(asset.id.as_str()).or_insert(asset);
    }
    let mut paths_by_id = HashMap::with_capacity(resolved_assets.len());
    for resolved in resolved_assets {
        paths_by_id
            .entry(resolved.asset_id.as_str())
            .or_insert(resolved.resolved_path.as_path());
    }
    validate_runtime_instance_counts(scene_document, resolved_assets)?;
    let mut instances = Vec::with_capacity(scene_document.instances.len());
    let mut runtime_node_count = STATIC_RUNTIME_SCENE_NODES;
    let scene_label = scene_document.name.as_deref().unwrap_or("Scene");
    let mut runtime_projection_text_bytes = scene_label.len()
        + SCENE_ID.len()
        + "scene".len()
        + KEY_LIGHT_ID.len()
        + SCENE_ID.len()
        + "Key Light".len()
        + "light".len();
    if runtime_projection_text_bytes > MAX_RUNTIME_PROJECTION_TEXT_BYTES {
        return Err(RendererError::AssetLoad {
            instance_id: scene_document
                .instances
                .first()
                .map(|instance| instance.id.clone())
                .unwrap_or_else(|| "scene".to_string()),
            asset_id: "scene".to_string(),
            path: String::new(),
            message: format!(
                "runtime scene projection text is {runtime_projection_text_bytes} bytes; maximum is {MAX_RUNTIME_PROJECTION_TEXT_BYTES}"
            ),
        });
    }
    // Source metadata and glTF budget preflight are asset-scoped. Reusing the
    // result avoids reparsing the same file once for every instance while the
    // vendor loader still builds an independent runtime graph per instance.
    let mut validated_asset_ids = HashSet::new();
    let mut gltf_projection_bones_by_asset: HashMap<&str, Vec<GltfProjectionBone>> = HashMap::new();

    for instance in &scene_document.instances {
        let Some(asset) = assets_by_id.get(instance.asset.as_str()).copied() else {
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
        if validated_asset_ids.insert(asset.id.as_str()) {
            let projection_bones =
                validate_runtime_asset_source_with_projection(path, asset.kind.as_str()).map_err(
                    |message| RendererError::AssetLoad {
                        instance_id: instance.id.clone(),
                        asset_id: asset.id.clone(),
                        path: path.display().to_string(),
                        message,
                    },
                )?;
            if let Some(projection_bones) = projection_bones {
                gltf_projection_bones_by_asset.insert(asset.id.as_str(), projection_bones);
            }
        }
        let (translation, rotation, scale) = instance_runtime_transform(instance)?;

        // glTF's vendor loader registers textures while constructing the
        // runtime graph. Reserve the projection text budget from the parsed
        // document first, so an oversized skeleton is rejected before any
        // loader-side cache can be mutated. The post-load check below compares
        // against this reservation without charging the aggregate twice.
        let projection_text_before_instance = runtime_projection_text_bytes;
        let expected_projection_text_total = if asset.kind == "gltf" {
            let bones = gltf_projection_bones_by_asset
                .get(asset.id.as_str())
                .ok_or_else(|| RendererError::AssetLoad {
                    instance_id: instance.id.clone(),
                    asset_id: asset.id.clone(),
                    path: path.display().to_string(),
                    message: "glTF projection metadata was not preflighted".to_string(),
                })?;
            Some(
                reserve_gltf_projection_text_budget(
                    &mut runtime_projection_text_bytes,
                    &instance.id,
                    bones,
                )
                .map_err(|message| RendererError::AssetLoad {
                    instance_id: instance.id.clone(),
                    asset_id: asset.id.clone(),
                    path: path.display().to_string(),
                    message,
                })?,
            )
        } else {
            None
        };

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

        reserve_runtime_node_budget(&mut runtime_node_count, skeleton_nodes.len() + 1).map_err(
            |message| RendererError::AssetLoad {
                instance_id: instance.id.clone(),
                asset_id: asset.id.clone(),
                path: path.display().to_string(),
                message,
            },
        )?;
        let bone_metadata = skeleton_nodes
            .iter()
            .map(|bone| (bone.index, bone.parent_index))
            .collect::<Vec<_>>();
        validate_bone_hierarchy(&bone_metadata).map_err(|message| RendererError::AssetLoad {
            instance_id: instance.id.clone(),
            asset_id: asset.id.clone(),
            path: path.display().to_string(),
            message,
        })?;
        let bones: Vec<RuntimeBone> = skeleton_nodes
            .into_iter()
            .map(|bone| RuntimeBone {
                source_index: bone.index,
                parent_source_index: bone.parent_index,
                label: bone.name,
                node: bone.node,
            })
            .collect();
        let post_load_projection_text_total = runtime_projection_text_next(
            projection_text_before_instance,
            &instance.id,
            bones.iter().map(|bone| {
                (
                    bone.source_index,
                    bone.parent_source_index,
                    bounded_runtime_label_len(&bone.label),
                )
            }),
        )
        .map_err(|message| RendererError::AssetLoad {
            instance_id: instance.id.clone(),
            asset_id: asset.id.clone(),
            path: path.display().to_string(),
            message,
        })?;
        if let Some(expected) = expected_projection_text_total {
            if post_load_projection_text_total != expected {
                return Err(RendererError::AssetLoad {
                    instance_id: instance.id.clone(),
                    asset_id: asset.id.clone(),
                    path: path.display().to_string(),
                    message: format!(
                        "glTF projection text preflight mismatch: expected {expected}, loaded {post_load_projection_text_total}"
                    ),
                });
            }
        } else {
            if post_load_projection_text_total > MAX_RUNTIME_PROJECTION_TEXT_BYTES {
                return Err(RendererError::AssetLoad {
                    instance_id: instance.id.clone(),
                    asset_id: asset.id.clone(),
                    path: path.display().to_string(),
                    message: format!(
                        "runtime scene projection text is {post_load_projection_text_total} bytes; maximum is {MAX_RUNTIME_PROJECTION_TEXT_BYTES}"
                    ),
                });
            }
            runtime_projection_text_bytes = post_load_projection_text_total;
        }

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
            bones,
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

fn validate_runtime_instance_counts(
    scene_document: &Scene,
    resolved_assets: &[ResolvedAssetPath],
) -> Result<(), RendererError> {
    let mut assets_by_id = HashMap::with_capacity(scene_document.assets.len());
    for asset in &scene_document.assets {
        assets_by_id.entry(asset.id.as_str()).or_insert(asset);
    }
    let mut paths_by_id = HashMap::with_capacity(resolved_assets.len());
    for resolved in resolved_assets {
        paths_by_id
            .entry(resolved.asset_id.as_str())
            .or_insert(resolved.resolved_path.as_path());
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();

    for instance in &scene_document.instances {
        let Some(asset) = assets_by_id.get(instance.asset.as_str()).copied() else {
            return Err(RendererError::MissingResolvedAsset {
                asset_id: instance.asset.clone(),
                instance_id: instance.id.clone(),
            });
        };
        let Some(path) = paths_by_id.get(asset.id.as_str()) else {
            return Err(RendererError::MissingResolvedAsset {
                asset_id: asset.id.clone(),
                instance_id: instance.id.clone(),
            });
        };
        let count = counts.entry(asset.id.as_str()).or_insert(0);
        let next_count = count
            .checked_add(1)
            .ok_or_else(|| RendererError::AssetInstanceLimit {
                asset_id: asset.id.clone(),
                path: path.display().to_string(),
                instances: usize::MAX,
                limit: MAX_RUNTIME_INSTANCES_PER_ASSET,
            })?;
        if next_count > MAX_RUNTIME_INSTANCES_PER_ASSET {
            return Err(RendererError::AssetInstanceLimit {
                asset_id: asset.id.clone(),
                path: path.display().to_string(),
                instances: next_count,
                limit: MAX_RUNTIME_INSTANCES_PER_ASSET,
            });
        }
        *count = next_count;
    }
    Ok(())
}

fn validate_bone_hierarchy(bones: &[(usize, Option<usize>)]) -> Result<(), String> {
    if bones.len() > MAX_BONES_PER_INSTANCE {
        return Err(format!(
            "skeleton has {} bones; maximum is {MAX_BONES_PER_INSTANCE}",
            bones.len()
        ));
    }

    let mut parents = HashMap::with_capacity(bones.len());
    for &(index, parent) in bones {
        if parents.insert(index, parent).is_some() {
            return Err(format!("skeleton contains duplicate bone index {index}"));
        }
    }

    // Reuse one visit map across walks so cycle detection stays iterative and
    // bounded without allocating a HashSet for every bone.
    let mut visits = HashMap::with_capacity(bones.len());
    for &(index, _) in bones {
        let generation = index.wrapping_add(1);
        let mut current = index;
        let mut depth = 0;
        loop {
            if visits.insert(current, generation) == Some(generation) {
                return Err(format!("skeleton contains a cycle at bone index {current}"));
            }
            let Some(parent) = parents.get(&current).copied() else {
                return Err(format!("skeleton parent index {current} is missing"));
            };
            let Some(parent) = parent else {
                break;
            };
            depth += 1;
            if depth > MAX_BONE_DEPTH {
                return Err(format!(
                    "skeleton depth exceeds maximum of {MAX_BONE_DEPTH}"
                ));
            }
            current = parent;
        }
    }
    Ok(())
}

fn reserve_runtime_node_budget(total: &mut usize, additional: usize) -> Result<(), String> {
    let next = total
        .checked_add(additional)
        .ok_or_else(|| "runtime scene projection node count overflowed".to_string())?;
    if next > MAX_RUNTIME_SCENE_NODES {
        return Err(format!(
            "runtime scene projection contains {next} nodes; maximum is {MAX_RUNTIME_SCENE_NODES}"
        ));
    }
    *total = next;
    Ok(())
}

#[cfg(test)]
fn reserve_runtime_projection_text_budget(
    total: &mut usize,
    instance_id: &str,
    bones: &[RuntimeBone],
) -> Result<(), String> {
    let next = runtime_projection_text_next(
        *total,
        instance_id,
        bones.iter().map(|bone| {
            (
                bone.source_index,
                bone.parent_source_index,
                bounded_runtime_label_len(&bone.label),
            )
        }),
    )?;
    if next > MAX_RUNTIME_PROJECTION_TEXT_BYTES {
        return Err(format!(
            "runtime scene projection text is {next} bytes; maximum is {MAX_RUNTIME_PROJECTION_TEXT_BYTES}"
        ));
    }
    *total = next;
    Ok(())
}

fn runtime_projection_text_next(
    total: usize,
    instance_id: &str,
    bones: impl IntoIterator<Item = (usize, Option<usize>, usize)>,
) -> Result<usize, String> {
    let mut next = total
        .checked_add(
            instance_id
                .len()
                .checked_mul(2)
                .ok_or_else(|| "runtime scene projection text size overflowed".to_string())?,
        )
        .and_then(|value| value.checked_add(SCENE_ID.len()))
        .and_then(|value| value.checked_add("mesh".len()))
        .ok_or_else(|| "runtime scene projection text size overflowed".to_string())?;
    for (source_index, parent_source_index, label_len) in bones {
        let bone_id = runtime_bone_id(instance_id, source_index);
        let parent_id = parent_source_index
            .map(|parent| runtime_bone_id(instance_id, parent))
            .unwrap_or_else(|| instance_id.to_string());
        let addition = bone_id
            .len()
            .checked_add(parent_id.len())
            .and_then(|value| value.checked_add(label_len))
            .and_then(|value| value.checked_add("bone".len()))
            .ok_or_else(|| "runtime scene projection text size overflowed".to_string())?;
        next = next
            .checked_add(addition)
            .ok_or_else(|| "runtime scene projection text size overflowed".to_string())?;
    }
    Ok(next)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GltfProjectionBone {
    source_index: usize,
    parent_source_index: Option<usize>,
    label_len: usize,
}

fn gltf_projection_bones(document: &gltf::Document) -> Vec<GltfProjectionBone> {
    let node_count = document.nodes().count();
    let mut parent_by_node = vec![None; node_count];
    for node in document.nodes() {
        for child in node.children() {
            parent_by_node[child.index()] = Some(node.index());
        }
    }
    let joint_nodes: HashSet<usize> = document
        .skins()
        .flat_map(|skin| skin.joints().map(|joint| joint.index()))
        .collect();
    document
        .nodes()
        .filter_map(|node| {
            let source_index = node.index();
            if !joint_nodes.contains(&source_index) {
                return None;
            }
            let parent_source_index =
                parent_by_node[source_index].filter(|parent| joint_nodes.contains(parent));
            let label_len = node
                .name()
                .filter(|name| !name.trim().is_empty())
                .map(bounded_runtime_label_len)
                .unwrap_or_else(|| {
                    bounded_runtime_label_len(&format!("Joint {}", source_index + 1))
                });
            Some(GltfProjectionBone {
                source_index,
                parent_source_index,
                label_len,
            })
        })
        .collect()
}

fn reserve_gltf_projection_text_budget(
    total: &mut usize,
    instance_id: &str,
    bones: &[GltfProjectionBone],
) -> Result<usize, String> {
    let next = runtime_projection_text_next(
        *total,
        instance_id,
        bones
            .iter()
            .map(|bone| (bone.source_index, bone.parent_source_index, bone.label_len)),
    )?;
    if next > MAX_RUNTIME_PROJECTION_TEXT_BYTES {
        return Err(format!(
            "runtime scene projection text is {next} bytes; maximum is {MAX_RUNTIME_PROJECTION_TEXT_BYTES}"
        ));
    }
    *total = next;
    Ok(next)
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

fn draw_bone_edges(window: &mut Window, scene_visible: bool, instances: &[RuntimeInstance]) {
    let mut joints: HashMap<u64, SceneNode3d> = HashMap::new();

    for instance in instances {
        let instance_visible = instance.root.is_visible();
        if !scene_visible || !instance_visible {
            continue;
        }

        for (parent, child) in &instance.bone_edges {
            if !bone_edge_is_visible(
                scene_visible,
                instance_visible,
                parent.is_visible(),
                child.is_visible(),
            ) {
                continue;
            }
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

fn bone_edge_is_visible(
    scene_visible: bool,
    instance_visible: bool,
    parent_visible: bool,
    child_visible: bool,
) -> bool {
    scene_visible && instance_visible && parent_visible && child_visible
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
    let mut previous = center + axis_a * radius;
    for &(sin, cos) in bone_ring_unit_points() {
        let current = center + (axis_a * cos + axis_b * sin) * radius;
        draw_bone_line(window, previous, current, color, BONE_RING_WIDTH);
        previous = current;
    }
}

fn bone_ring_unit_points() -> &'static [(f32, f32)] {
    BONE_RING_UNIT_POINTS
        .get_or_init(|| {
            let tau = std::f32::consts::PI * 2.0;
            (1..=BONE_RING_SEGMENTS)
                .map(|segment| {
                    let angle = tau * segment as f32 / BONE_RING_SEGMENTS as f32;
                    angle.sin_cos()
                })
                .collect()
        })
        .as_slice()
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

fn project_world_to_viewport(
    point: Vec3,
    camera: CameraState,
    settings: CameraSettings,
    rect: ViewportRect,
) -> Option<Vec2> {
    if !point.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return None;
    }
    let target = Vec3::from_array(camera.target);
    let (sin_yaw, cos_yaw) = camera.yaw.sin_cos();
    let (sin_pitch, cos_pitch) = camera.pitch.sin_cos();
    let eye =
        target + camera.distance * Vec3::new(cos_pitch * cos_yaw, sin_pitch, cos_pitch * sin_yaw);
    let view = glam::camera::rh::view::look_at_mat4(eye, target, Vec3::Y);
    let aspect = rect.width / rect.height;
    let fov = settings
        .fov_degrees
        .to_radians()
        .clamp(0.01, std::f32::consts::PI - 0.01);
    let projection = match settings.projection {
        CameraProjection::Perspective => {
            glam::camera::rh::proj::opengl::perspective(fov, aspect, 0.1, 1000.0)
        }
        CameraProjection::Orthographic => {
            let half_height = camera.distance * (fov * 0.5).tan();
            glam::camera::rh::proj::directx::orthographic(
                -half_height * aspect,
                half_height * aspect,
                -half_height,
                half_height,
                0.1,
                1000.0,
            )
        }
    };
    let clip = projection * view * point.extend(1.0);
    if !clip.is_finite() || clip.w.abs() <= f32::EPSILON {
        return None;
    }
    if settings.projection == CameraProjection::Perspective && clip.w <= 0.0 {
        return None;
    }
    let ndc = clip.truncate() / clip.w;
    Some(Vec2::new(
        (ndc.x + 1.0) * rect.width * 0.5,
        (1.0 - ndc.y) * rect.height * 0.5,
    ))
}

fn projected_manipulator_axes(
    origin: Vec3,
    transform: SceneTransform,
    orientation: ManipulatorOrientation,
    camera: CameraState,
    settings: CameraSettings,
    rect: ViewportRect,
) -> Option<(Vec2, Vec<ProjectedManipulatorAxis>)> {
    let screen_origin = project_world_to_viewport(origin, camera, settings, rect)?;
    let basis = if orientation == ManipulatorOrientation::Local {
        let rotation = Quat::from_array(transform.rotation).normalize();
        [rotation * Vec3::X, rotation * Vec3::Y, rotation * Vec3::Z]
    } else {
        [Vec3::X, Vec3::Y, Vec3::Z]
    };
    let axes = basis
        .into_iter()
        .enumerate()
        .filter_map(|(index, world_axis)| {
            let screen_unit =
                project_world_to_viewport(origin + world_axis, camera, settings, rect)?;
            let delta = screen_unit - screen_origin;
            let pixels_per_world_unit = delta.length();
            if !pixels_per_world_unit.is_finite() || pixels_per_world_unit < 3.0 {
                return None;
            }
            Some(ProjectedManipulatorAxis {
                index,
                world_axis,
                screen_direction: delta / pixels_per_world_unit,
                pixels_per_world_unit,
            })
        })
        .collect();
    Some((screen_origin, axes))
}

fn projected_rotation_rings(
    origin: Vec3,
    screen_origin: Vec2,
    axes: &[ProjectedManipulatorAxis],
    world_units_per_css_px: f32,
    camera: CameraState,
    settings: CameraSettings,
    rect: ViewportRect,
) -> Vec<ProjectedRotationRing> {
    if !world_units_per_css_px.is_finite() || world_units_per_css_px <= f32::EPSILON {
        return Vec::new();
    }
    let radius = MANIPULATOR_RING_RADIUS_CSS_PX * world_units_per_css_px;
    (0..3)
        .filter_map(|index| {
            let world_axis = axes.get(index)?.world_axis;
            let basis_a = axes[(index + 1) % axes.len().max(1)].world_axis;
            let basis_b = world_axis.cross(basis_a).normalize_or_zero();
            if basis_b.length_squared() <= f32::EPSILON {
                return None;
            }
            Some((index, world_axis, basis_a, basis_b))
        })
        .filter_map(|(index, world_axis, basis_a, basis_b)| {
            let world_points = (0..=MANIPULATOR_RING_SEGMENTS)
                .map(|segment| {
                    let angle =
                        std::f32::consts::TAU * segment as f32 / MANIPULATOR_RING_SEGMENTS as f32;
                    origin + (basis_a * angle.cos() + basis_b * angle.sin()) * radius
                })
                .collect::<Vec<_>>();
            let screen_points = world_points
                .iter()
                .map(|point| project_world_to_viewport(*point, camera, settings, rect))
                .collect::<Option<Vec<_>>>()?;
            if screen_points
                .iter()
                .all(|point| point.distance(screen_origin) < 3.0)
            {
                return None;
            }
            Some(ProjectedRotationRing {
                index,
                world_axis,
                world_points,
                screen_points,
                is_view: false,
            })
        })
        .collect()
}

fn camera_view_basis(camera: CameraState) -> (Vec3, Vec3, Vec3) {
    let target = Vec3::from_array(camera.target);
    let (sin_yaw, cos_yaw) = camera.yaw.sin_cos();
    let (sin_pitch, cos_pitch) = camera.pitch.sin_cos();
    let eye =
        target + camera.distance * Vec3::new(cos_pitch * cos_yaw, sin_pitch, cos_pitch * sin_yaw);
    let forward = unit_or(target - eye, Vec3::NEG_Z);
    let right = unit_or(forward.cross(Vec3::Y), Vec3::X);
    let up = unit_or(right.cross(forward), Vec3::Y);
    (right, up, forward)
}

fn manipulator_world_units_per_css_px(
    origin: Vec3,
    camera: CameraState,
    settings: CameraSettings,
    rect: ViewportRect,
) -> Option<f32> {
    let screen_origin = project_world_to_viewport(origin, camera, settings, rect)?;
    let (right, up, _) = camera_view_basis(camera);
    let right_pixels =
        project_world_to_viewport(origin + right, camera, settings, rect)?.distance(screen_origin);
    let up_pixels =
        project_world_to_viewport(origin + up, camera, settings, rect)?.distance(screen_origin);
    let pixels_per_world_unit = (right_pixels + up_pixels) * 0.5;
    (pixels_per_world_unit.is_finite() && pixels_per_world_unit >= 3.0)
        .then_some(pixels_per_world_unit.recip())
}

fn projected_view_rotation_ring(
    origin: Vec3,
    world_units_per_css_px: f32,
    camera: CameraState,
    settings: CameraSettings,
    rect: ViewportRect,
) -> Option<ProjectedRotationRing> {
    let (right, up, forward) = camera_view_basis(camera);
    if !world_units_per_css_px.is_finite() || world_units_per_css_px <= f32::EPSILON {
        return None;
    }
    let radius = MANIPULATOR_OUTER_RING_RADIUS_CSS_PX * world_units_per_css_px;
    let world_points = (0..=MANIPULATOR_RING_SEGMENTS)
        .map(|segment| {
            let angle = std::f32::consts::TAU * segment as f32 / MANIPULATOR_RING_SEGMENTS as f32;
            origin + (right * angle.cos() + up * angle.sin()) * radius
        })
        .collect::<Vec<_>>();
    let screen_points = world_points
        .iter()
        .map(|point| project_world_to_viewport(*point, camera, settings, rect))
        .collect::<Option<Vec<_>>>()?;
    Some(ProjectedRotationRing {
        index: 3,
        world_axis: forward,
        world_points,
        screen_points,
        is_view: true,
    })
}

fn projected_axis_plane(
    axes: &[ProjectedManipulatorAxis],
    first: usize,
    second: usize,
) -> Option<ProjectedManipulatorPlane> {
    let first_axis = *axes.iter().find(|axis| axis.index == first)?;
    let second_axis = *axes.iter().find(|axis| axis.index == second)?;
    Some(ProjectedManipulatorPlane {
        world_axes: [first_axis.world_axis, second_axis.world_axis],
        screen_axes: [
            first_axis.screen_direction * first_axis.pixels_per_world_unit,
            second_axis.screen_direction * second_axis.pixels_per_world_unit,
        ],
        pixels_per_world_unit: [
            first_axis.pixels_per_world_unit,
            second_axis.pixels_per_world_unit,
        ],
    })
}

fn projected_manipulator_handles(
    mode: ManipulatorMode,
    origin: Vec3,
    screen_origin: Vec2,
    axes: &[ProjectedManipulatorAxis],
    rings: &[ProjectedRotationRing],
    context: ManipulatorProjectionContext,
) -> Vec<ProjectedManipulatorHandle> {
    if mode == ManipulatorMode::Rotate {
        return rings
            .iter()
            .map(|ring| ProjectedManipulatorHandle {
                kind: if ring.is_view {
                    ManipulatorHandleKind::ViewRotate
                } else {
                    ManipulatorHandleKind::RotateAxis(ring.index)
                },
                world_points: ring.world_points.clone(),
                hit: ManipulatorHitShape::Polyline(ring.screen_points.clone()),
                axis: None,
                plane: None,
            })
            .collect();
    }

    let mut handles = Vec::new();
    for axis in axes {
        let world_length = MANIPULATOR_LENGTH_CSS_PX * context.world_units_per_css_px;
        let end = origin + axis.world_axis * world_length;
        let Some(screen_end) =
            project_world_to_viewport(end, context.camera, context.settings, context.rect)
        else {
            continue;
        };
        handles.push(ProjectedManipulatorHandle {
            kind: ManipulatorHandleKind::Axis(axis.index),
            world_points: vec![origin, end],
            hit: ManipulatorHitShape::Segment(screen_origin, screen_end),
            axis: Some(*axis),
            plane: None,
        });
    }
    if mode == ManipulatorMode::Translate {
        for (first, second) in [(0, 1), (1, 2), (2, 0)] {
            let Some(plane) = projected_axis_plane(axes, first, second) else {
                continue;
            };
            let corners = plane_world_corners(origin, plane, context.world_units_per_css_px);
            let screen_corners = corners
                .iter()
                .map(|point| {
                    project_world_to_viewport(
                        *point,
                        context.camera,
                        context.settings,
                        context.rect,
                    )
                })
                .collect::<Option<Vec<_>>>();
            let Some(screen_corners) = screen_corners else {
                continue;
            };
            handles.push(ProjectedManipulatorHandle {
                kind: ManipulatorHandleKind::Plane(first, second),
                world_points: corners.to_vec(),
                hit: ManipulatorHitShape::Polygon(screen_corners),
                axis: None,
                plane: Some(plane),
            });
        }
        let (right, up, _) = camera_view_basis(context.camera);
        let Some(view_plane) = projected_view_plane(
            origin,
            right,
            up,
            context.camera,
            context.settings,
            context.rect,
        ) else {
            return handles;
        };
        handles.push(ProjectedManipulatorHandle {
            kind: ManipulatorHandleKind::Center,
            world_points: center_marker_points(origin, view_plane, context.world_units_per_css_px),
            hit: ManipulatorHitShape::Circle {
                center: screen_origin,
                radius: MANIPULATOR_CENTER_RADIUS_CSS_PX,
            },
            axis: None,
            plane: Some(view_plane),
        });
    } else {
        if axes.is_empty() {
            return handles;
        }
        let radius = MANIPULATOR_MARKER_CUBE_CSS_PX * context.world_units_per_css_px * 0.5;
        let basis = [
            axes.iter()
                .find(|candidate| candidate.index == 0)
                .map(|candidate| candidate.world_axis)
                .unwrap_or(Vec3::X),
            axes.iter()
                .find(|candidate| candidate.index == 1)
                .map(|candidate| candidate.world_axis)
                .unwrap_or(Vec3::Y),
            axes.iter()
                .find(|candidate| candidate.index == 2)
                .map(|candidate| candidate.world_axis)
                .unwrap_or(Vec3::Z),
        ];
        let marker = cube_marker_points(origin, basis, radius);
        handles.push(ProjectedManipulatorHandle {
            kind: ManipulatorHandleKind::UniformScale,
            world_points: marker,
            hit: ManipulatorHitShape::Circle {
                center: screen_origin,
                radius: MANIPULATOR_CENTER_RADIUS_CSS_PX,
            },
            axis: None,
            plane: None,
        });
    }
    handles
}

fn projected_view_plane(
    origin: Vec3,
    right: Vec3,
    up: Vec3,
    camera: CameraState,
    settings: CameraSettings,
    rect: ViewportRect,
) -> Option<ProjectedManipulatorPlane> {
    let screen_origin = project_world_to_viewport(origin, camera, settings, rect)?;
    let right_screen = project_world_to_viewport(origin + right, camera, settings, rect)?;
    let up_screen = project_world_to_viewport(origin + up, camera, settings, rect)?;
    let right_delta = right_screen - screen_origin;
    let up_delta = up_screen - screen_origin;
    let right_ppu = right_delta.length();
    let up_ppu = up_delta.length();
    if right_ppu < 3.0 || up_ppu < 3.0 {
        return None;
    }
    Some(ProjectedManipulatorPlane {
        world_axes: [right, up],
        screen_axes: [right_delta, up_delta],
        pixels_per_world_unit: [right_ppu, up_ppu],
    })
}

fn plane_world_corners(
    origin: Vec3,
    plane: ProjectedManipulatorPlane,
    world_units_per_css_px: f32,
) -> [Vec3; 4] {
    let offset = MANIPULATOR_PLANE_OFFSET_CSS_PX;
    let half = MANIPULATOR_PLANE_HALF_SIZE_CSS_PX;
    let center = origin
        + plane.world_axes[0] * (offset * world_units_per_css_px)
        + plane.world_axes[1] * (offset * world_units_per_css_px);
    let a = plane.world_axes[0] * (half * world_units_per_css_px);
    let b = plane.world_axes[1] * (half * world_units_per_css_px);
    [
        center - a - b,
        center + a - b,
        center + a + b,
        center - a + b,
    ]
}

fn center_marker_points(
    origin: Vec3,
    plane: ProjectedManipulatorPlane,
    world_units_per_css_px: f32,
) -> Vec<Vec3> {
    let radius = MANIPULATOR_CENTER_RADIUS_CSS_PX * world_units_per_css_px;
    let a = plane.world_axes[0] * radius;
    let b = plane.world_axes[1] * radius;
    vec![origin + a, origin + b, origin - a, origin - b]
}

fn cube_marker_points(origin: Vec3, basis: [Vec3; 3], half: f32) -> Vec<Vec3> {
    let [a, b, c] = basis;
    vec![
        origin - a * half - b * half - c * half,
        origin + a * half - b * half - c * half,
        origin + a * half + b * half - c * half,
        origin - a * half + b * half - c * half,
        origin - a * half - b * half + c * half,
        origin + a * half - b * half + c * half,
        origin + a * half + b * half + c * half,
        origin - a * half + b * half + c * half,
    ]
}

fn point_in_polygon(point: Vec2, polygon: &[Vec2]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut previous = *polygon.last().unwrap();
    for &current in polygon {
        let denominator = previous.y - current.y;
        if ((current.y > point.y) != (previous.y > point.y))
            && denominator.abs() > f32::EPSILON
            && point.x < (previous.x - current.x) * (point.y - current.y) / denominator + current.x
        {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

fn manipulator_hit_distance(pointer: Vec2, shape: &ManipulatorHitShape) -> Option<f32> {
    match shape {
        ManipulatorHitShape::Segment(start, end) => {
            let distance = point_segment_distance(pointer, *start, *end);
            (distance <= MANIPULATOR_HIT_RADIUS_CSS_PX).then_some(distance)
        }
        ManipulatorHitShape::Polygon(points) => {
            if point_in_polygon(pointer, points) {
                Some(0.0)
            } else {
                nearest_polyline_hit(pointer, &closed_polyline_points(points))
                    .map(|(distance, _)| distance)
                    .filter(|distance| *distance <= MANIPULATOR_HIT_RADIUS_CSS_PX)
            }
        }
        ManipulatorHitShape::Circle { center, radius } => {
            let distance = pointer.distance(*center);
            (distance <= *radius + MANIPULATOR_HIT_RADIUS_CSS_PX * 0.5).then_some(distance)
        }
        ManipulatorHitShape::Polyline(points) => nearest_polyline_hit(pointer, points)
            .map(|(distance, _)| distance)
            .filter(|distance| *distance <= MANIPULATOR_HIT_RADIUS_CSS_PX),
    }
}

fn pick_manipulator_handle(
    view: &ManipulatorView,
    pointer: Vec2,
) -> Option<&ProjectedManipulatorHandle> {
    view.handles
        .iter()
        .filter_map(|handle| {
            manipulator_hit_distance(pointer, &handle.hit)
                .map(|distance| (handle.kind.priority(), distance, handle))
        })
        .min_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.total_cmp(&right.1))
        })
        .map(|candidate| candidate.2)
}

fn closed_polyline_points(points: &[Vec2]) -> Vec<Vec2> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut closed = points.to_vec();
    if closed.first() != closed.last() {
        closed.push(closed[0]);
    }
    closed
}

fn closed_polyline(points: &[Vec3]) -> Vec<(Vec3, Vec3)> {
    if points.len() < 2 {
        return Vec::new();
    }
    points
        .iter()
        .copied()
        .zip(points.iter().copied().cycle().skip(1))
        .take(points.len())
        .collect()
}

fn unit_or_2d(value: Vec2, fallback: Vec2) -> Vec2 {
    if value.is_finite() && value.length_squared() > f32::EPSILON {
        value.normalize()
    } else {
        fallback.normalize_or_zero()
    }
}

fn manipulator_width_scale(scale_factor: f32) -> f32 {
    if scale_factor.is_finite() {
        scale_factor.max(1.0)
    } else {
        1.0
    }
}

fn rotation_drag_angle_sign(start_vector: Vec2, screen_tangent: Vec2, is_view: bool) -> f32 {
    let tangent_cross = cross_2d(start_vector, screen_tangent);
    let projected_sign = if tangent_cross.abs() > f32::EPSILON {
        tangent_cross.signum()
    } else {
        1.0
    };
    // The yellow ring rotates around camera forward (away from the viewer),
    // so its right-handed world-space sign is opposite to the apparent
    // clockwise/counter-clockwise motion on screen.
    if is_view {
        -projected_sign
    } else {
        projected_sign
    }
}

fn manipulator_physical_width(css_width: f32, scale_factor: f32) -> f32 {
    css_width * manipulator_width_scale(scale_factor)
}

fn draw_manipulator_cone(
    window: &mut Window,
    tip: Vec3,
    axis: Vec3,
    world_units_per_css_px: f32,
    color: Color,
    width_scale: f32,
) {
    let depth = MANIPULATOR_CONE_DEPTH_CSS_PX * world_units_per_css_px;
    let radius = MANIPULATOR_CONE_BASE_CSS_PX * world_units_per_css_px;
    let base = tip - axis * depth;
    let side = perpendicular_to(axis);
    let other = unit_or(axis.cross(side), Vec3::Z);
    let ring: Vec<Vec3> = (0..MANIPULATOR_CONE_RIBS)
        .map(|index| {
            let angle = std::f32::consts::TAU * index as f32 / MANIPULATOR_CONE_RIBS as f32;
            base + (side * angle.cos() + other * angle.sin()) * radius
        })
        .collect();
    for index in 0..MANIPULATOR_CONE_RIBS {
        let next = (index + 1) % MANIPULATOR_CONE_RIBS;
        window.draw_triangle_with_depth_bias([tip, ring[index], ring[next]], color, 0.99);
        window.draw_triangle_with_depth_bias([base, ring[next], ring[index]], color, 0.99);
    }
    // Keep only the silhouette of the base. The cone body itself is solid;
    // ribs and intermediate rings made it read as a wire cage.
    for segment in closed_polyline(&ring) {
        window.draw_line_with_depth_bias(
            segment.0,
            segment.1,
            color,
            MANIPULATOR_DETAIL_WIDTH_PX * 0.75 * width_scale,
            false,
            0.99,
        );
    }
}

fn draw_manipulator_center_marker(
    window: &mut Window,
    _origin: Vec3,
    points: &[Vec3],
    color: Color,
    width_scale: f32,
) {
    for segment in closed_polyline(points) {
        window.draw_line_with_depth_bias(
            segment.0,
            segment.1,
            color,
            MANIPULATOR_DETAIL_WIDTH_PX * width_scale,
            false,
            0.99,
        );
    }
}

fn draw_manipulator_wire_cube(window: &mut Window, points: &[Vec3], color: Color, width: f32) {
    if points.len() < 8 {
        return;
    }
    let edges = [
        (0, 1),
        (1, 2),
        (2, 3),
        (3, 0),
        (4, 5),
        (5, 6),
        (6, 7),
        (7, 4),
        (0, 4),
        (1, 5),
        (2, 6),
        (3, 7),
    ];
    for (start, end) in edges {
        window.draw_line_with_depth_bias(points[start], points[end], color, width, false, 0.99);
    }
}

fn draw_manipulator_solid_cube(
    window: &mut Window,
    points: &[Vec3],
    color: Color,
    line_width: f32,
) {
    if points.len() != 8 {
        return;
    }
    for face in [
        [0, 1, 2, 3],
        [4, 7, 6, 5],
        [0, 4, 5, 1],
        [1, 5, 6, 2],
        [2, 6, 7, 3],
        [3, 7, 4, 0],
    ] {
        window.draw_triangle_with_depth_bias(
            [points[face[0]], points[face[1]], points[face[2]]],
            color,
            0.99,
        );
        window.draw_triangle_with_depth_bias(
            [points[face[0]], points[face[2]], points[face[3]]],
            color,
            0.99,
        );
    }
    draw_manipulator_wire_cube(window, points, color, line_width);
}

fn manipulator_drag_transform(drag: ManipulatorDrag, pointer: Vec2) -> (String, SceneTransform) {
    let pointer_delta = pointer - drag.start_pointer();
    match drag {
        ManipulatorDrag::Translate {
            node_id,
            axis,
            start_transform,
            snap,
            snap_increment,
            ..
        } => {
            let mut world_delta =
                pointer_delta.dot(axis.screen_direction) / axis.pixels_per_world_unit;
            if snap {
                world_delta = snap_scalar(world_delta, snap_increment);
            }
            let mut transform = start_transform;
            let next = Vec3::from_array(transform.translation) + axis.world_axis * world_delta;
            transform.translation = next.to_array();
            (node_id, transform)
        }
        ManipulatorDrag::TranslatePlane {
            node_id,
            plane,
            start_transform,
            snap,
            snap_increment,
            ..
        } => {
            let mut coefficients = solve_plane_screen_delta(pointer_delta, plane);
            if snap {
                // Snap in the captured plane coordinates before recombining
                // the basis. Quantizing world xyz independently would move a
                // Local plane out of its two-axis manifold.
                coefficients[0] = snap_scalar(coefficients[0], snap_increment);
                coefficients[1] = snap_scalar(coefficients[1], snap_increment);
            }
            let delta =
                plane.world_axes[0] * coefficients[0] + plane.world_axes[1] * coefficients[1];
            let mut transform = start_transform;
            transform.translation = (Vec3::from_array(transform.translation) + delta).to_array();
            (node_id, transform)
        }
        ManipulatorDrag::Rotate {
            node_id,
            world_axis,
            accumulated_angle,
            start_transform,
            snap,
            snap_increment,
            ..
        } => {
            let angle = if snap {
                snap_scalar(accumulated_angle, snap_increment)
            } else {
                accumulated_angle
            };
            let start_rotation = Quat::from_array(start_transform.rotation).normalize();
            let mut transform = start_transform;
            transform.rotation = (Quat::from_axis_angle(world_axis, angle) * start_rotation)
                .normalize()
                .to_array();
            (node_id, transform)
        }
        ManipulatorDrag::Scale {
            node_id,
            axis,
            start_transform,
            snap,
            snap_increment,
            ..
        } => {
            let screen_delta = pointer_delta.dot(axis.screen_direction);
            let factor = (screen_delta / MANIPULATOR_LENGTH_CSS_PX).exp();
            let mut transform = start_transform;
            let candidate = transform.scale[axis.index] * factor;
            transform.scale[axis.index] = if snap {
                snap_scalar(candidate, snap_increment).clamp(0.001, 1000.0)
            } else {
                candidate.clamp(0.001, 1000.0)
            };
            (node_id, transform)
        }
        ManipulatorDrag::ScaleUniform {
            node_id,
            screen_direction,
            start_transform,
            snap,
            snap_increment,
            ..
        } => {
            let mut factor =
                (pointer_delta.dot(screen_direction) / MANIPULATOR_LENGTH_CSS_PX).exp();
            factor = factor.clamp(0.001, 1000.0);
            if snap {
                factor = snap_scalar(factor, snap_increment).clamp(0.001, 1000.0);
            }
            let mut transform = start_transform;
            for component in &mut transform.scale {
                *component = (*component * factor).clamp(0.001, 1000.0);
            }
            (node_id, transform)
        }
    }
}

fn solve_plane_screen_delta(delta: Vec2, plane: ProjectedManipulatorPlane) -> [f32; 2] {
    let a = plane.screen_axes[0];
    let b = plane.screen_axes[1];
    let determinant = a.x * b.y - a.y * b.x;
    if !determinant.is_finite() || determinant.abs() <= 0.001 {
        let first_ppu = plane.pixels_per_world_unit[0].max(0.001);
        let second_ppu = plane.pixels_per_world_unit[1].max(0.001);
        return [
            delta.dot(a) / (first_ppu * first_ppu),
            delta.dot(b) / (second_ppu * second_ppu),
        ];
    }
    [
        (delta.x * b.y - delta.y * b.x) / determinant,
        (a.x * delta.y - a.y * delta.x) / determinant,
    ]
}

fn snap_scalar(value: f32, increment: f32) -> f32 {
    if !value.is_finite() || !increment.is_finite() || increment <= 0.0 {
        return value;
    }
    (value / increment).round() * increment
}

fn cross_2d(left: Vec2, right: Vec2) -> f32 {
    left.x * right.y - left.y * right.x
}

/// Return the signed shortest arc from one screen-space ring vector to the
/// next. Applying this incrementally keeps a drag continuous across ±π while
/// `atan2` remains stable for angles close to 180 degrees.
fn signed_arc_angle(start: Vec2, current: Vec2) -> Option<f32> {
    if !start.is_finite() || !current.is_finite() {
        return None;
    }
    let length_product = start.length() * current.length();
    if !length_product.is_finite() || length_product <= f32::EPSILON {
        return None;
    }
    Some(cross_2d(start, current).atan2(start.dot(current)))
}

fn nearest_polyline_hit(point: Vec2, points: &[Vec2]) -> Option<(f32, Vec2)> {
    points
        .windows(2)
        .filter_map(|segment| {
            let delta = segment[1] - segment[0];
            let length = delta.length();
            if !length.is_finite() || length <= f32::EPSILON {
                return None;
            }
            Some((
                point_segment_distance(point, segment[0], segment[1]),
                delta / length,
            ))
        })
        .min_by(|left, right| left.0.total_cmp(&right.0))
}

fn point_segment_distance(point: Vec2, start: Vec2, end: Vec2) -> f32 {
    let segment = end - start;
    let length_squared = segment.length_squared();
    if length_squared <= f32::EPSILON {
        return point.distance(start);
    }
    let t = ((point - start).dot(segment) / length_squared).clamp(0.0, 1.0);
    point.distance(start + segment * t)
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

fn first_timeline_playback_target(instances: &[RuntimeInstance]) -> Option<(String, usize)> {
    instances
        .iter()
        .find(|instance| instance.player.clip_count() > 0)
        .map(|instance| {
            (
                instance.id.clone(),
                instance.player.current_clip_index().unwrap_or(0),
            )
        })
}

fn resolve_timeline_playback_target<'a>(
    instances: &'a [RuntimeInstance],
    requested: Option<&(String, usize)>,
) -> Option<(&'a RuntimeInstance, usize)> {
    requested
        .and_then(|(instance_id, clip_index)| {
            instances
                .iter()
                .find(|instance| {
                    instance.id == *instance_id
                        && instance.player.clip_duration(*clip_index).is_some()
                })
                .map(|instance| (instance, *clip_index))
        })
        .or_else(|| {
            instances
                .iter()
                .find(|instance| instance.player.clip_count() > 0)
                .map(|instance| (instance, instance.player.current_clip_index().unwrap_or(0)))
        })
}

fn append_runtime_instance_summaries(
    nodes: &mut Vec<SceneNodeSummary>,
    instance: &RuntimeInstance,
) {
    let visible = instance.root.is_visible();
    nodes.push(SceneNodeSummary {
        id: instance.id.clone(),
        parent: Some(SCENE_ID.to_string()),
        label: instance.id.clone(),
        kind: "mesh".to_string(),
        visible,
    });
    for bone in &instance.bones {
        nodes.push(SceneNodeSummary {
            id: runtime_bone_id(&instance.id, bone.source_index),
            parent: bone
                .parent_source_index
                .map(|parent| runtime_bone_id(&instance.id, parent))
                .or_else(|| Some(instance.id.clone())),
            label: bounded_runtime_label(&bone.label),
            kind: "bone".to_string(),
            visible: bone.node.is_visible(),
        });
    }
}

fn bounded_runtime_label(value: &str) -> String {
    if value.len() <= MAX_RUNTIME_LABEL_BYTES {
        return value.to_string();
    }

    const ELLIPSIS: &str = "…";
    let prefix_limit = MAX_RUNTIME_LABEL_BYTES - ELLIPSIS.len();
    let mut end = prefix_limit.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut label = String::with_capacity(end + ELLIPSIS.len());
    label.push_str(&value[..end]);
    label.push_str(ELLIPSIS);
    label
}

fn bounded_runtime_label_len(value: &str) -> usize {
    if value.len() <= MAX_RUNTIME_LABEL_BYTES {
        return value.len();
    }

    const ELLIPSIS: &str = "…";
    let prefix_limit = MAX_RUNTIME_LABEL_BYTES - ELLIPSIS.len();
    let mut end = prefix_limit.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    end + ELLIPSIS.len()
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

fn camera_state_equal(left: CameraState, right: CameraState) -> bool {
    left.target == right.target
        && left.yaw == right.yaw
        && left.pitch == right.pitch
        && left.distance == right.distance
}

pub fn apply_viewport_rect(renderer: &mut Renderer, rect: ViewportRect) {
    renderer.set_viewport_rect(rect);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{
        AssetPathKind, ResolvedAssetPath, SceneAsset, SceneInstance, SceneTransform,
    };
    use crate::scene_projection::SceneTransform as ProjectionTransform;
    use kiss3d::scene::{AnimationChannel, AnimationClip, Interpolation};

    fn instance(transform: SceneTransform) -> SceneInstance {
        SceneInstance {
            id: "model-1".to_string(),
            asset: "model".to_string(),
            transform,
            visible: true,
        }
    }

    fn runtime_budget_fixture(counts: &[usize]) -> (Scene, Vec<ResolvedAssetPath>) {
        let assets = counts
            .iter()
            .enumerate()
            .map(|(index, _)| SceneAsset {
                id: format!("asset-{index}"),
                kind: "gltf".to_string(),
                path: format!("asset-{index}.glb"),
            })
            .collect::<Vec<_>>();
        let instances = counts
            .iter()
            .enumerate()
            .flat_map(|(asset_index, count)| {
                (0..*count).map(move |instance_index| SceneInstance {
                    id: format!("instance-{asset_index}-{instance_index}"),
                    asset: format!("asset-{asset_index}"),
                    transform: SceneTransform {
                        translation: [0.0, 0.0, 0.0],
                        rotation: [0.0, 0.0, 0.0, 1.0],
                        scale: [1.0, 1.0, 1.0],
                    },
                    visible: true,
                })
            })
            .collect::<Vec<_>>();
        let resolved = assets
            .iter()
            .map(|asset| ResolvedAssetPath {
                asset_id: asset.id.clone(),
                stored_path: PathBuf::from(&asset.path),
                resolved_path: PathBuf::from(&asset.path),
                kind: AssetPathKind::PortableRelative,
            })
            .collect::<Vec<_>>();
        let mut scene = Scene::empty("runtime-budget");
        scene.assets = assets;
        scene.instances = instances;
        (scene, resolved)
    }

    #[test]
    fn camera_state_equal_only_accepts_unchanged_pose() {
        let current = CameraState {
            target: [1.0, 2.0, 3.0],
            yaw: -0.8,
            pitch: 0.4,
            distance: 3.5,
        };
        assert!(camera_state_equal(current, current));
        assert!(!camera_state_equal(
            current,
            CameraState {
                yaw: current.yaw + 0.01,
                ..current
            }
        ));
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
    fn bone_ring_unit_points_are_cached_and_close_the_ring() {
        let first = bone_ring_unit_points();
        let second = bone_ring_unit_points();
        assert_eq!(first.as_ptr(), second.as_ptr());
        assert_eq!(first.len(), BONE_RING_SEGMENTS);
        assert!(first[0].0 > 0.0);
        assert!(first[0].1 < 1.0);
        let &(sin, cos) = first.last().unwrap();
        assert!(sin.abs() < 1e-6);
        assert!((cos - 1.0).abs() < 1e-6);
    }

    #[test]
    fn bone_hierarchy_validation_rejects_deep_missing_and_cyclic_parents() {
        assert!(validate_bone_hierarchy(&[(0, None), (1, Some(0))]).is_ok());

        let deep = (0..=MAX_BONE_DEPTH + 1)
            .map(|index| (index, index.checked_sub(1)))
            .collect::<Vec<_>>();
        let error = validate_bone_hierarchy(&deep).unwrap_err();
        assert!(error.contains("depth exceeds"));

        let error = validate_bone_hierarchy(&[(0, Some(1))]).unwrap_err();
        assert!(error.contains("parent index 1 is missing"));

        let error = validate_bone_hierarchy(&[(0, Some(1)), (1, Some(0))]).unwrap_err();
        assert!(error.contains("cycle"));
    }

    #[test]
    fn runtime_scene_node_budget_matches_projection_wire_cap() {
        let mut total = STATIC_RUNTIME_SCENE_NODES;
        assert!(reserve_runtime_node_budget(
            &mut total,
            MAX_RUNTIME_SCENE_NODES - STATIC_RUNTIME_SCENE_NODES,
        )
        .is_ok());
        assert_eq!(total, MAX_RUNTIME_SCENE_NODES);

        let error = reserve_runtime_node_budget(&mut total, 1).unwrap_err();
        assert!(error.contains("runtime scene projection"));
        assert!(error.contains("maximum"));
    }

    #[test]
    fn runtime_projection_text_budget_rejects_oversized_payloads() {
        let mut total = MAX_RUNTIME_PROJECTION_TEXT_BYTES - 10;
        let bones = vec![RuntimeBone {
            source_index: 0,
            parent_source_index: None,
            label: "x".repeat(MAX_RUNTIME_LABEL_BYTES),
            node: SceneNode3d::empty(),
        }];
        let error = reserve_runtime_projection_text_budget(&mut total, "id", &bones)
            .expect_err("projection text budget must reject oversized payloads");
        assert!(error.contains("projection text"));
        assert!(error.contains("maximum"));
    }

    #[test]
    fn gltf_projection_preflight_matches_loaded_bone_accounting() {
        let metadata = vec![
            GltfProjectionBone {
                source_index: 2,
                parent_source_index: None,
                label_len: bounded_runtime_label_len("Root"),
            },
            GltfProjectionBone {
                source_index: 7,
                parent_source_index: Some(2),
                label_len: bounded_runtime_label_len("Hand"),
            },
        ];
        let mut preflight_total = STATIC_RUNTIME_SCENE_NODES;
        let expected =
            reserve_gltf_projection_text_budget(&mut preflight_total, "hero", &metadata).unwrap();
        let loaded = [
            RuntimeBone {
                source_index: 2,
                parent_source_index: None,
                label: "Root".to_string(),
                node: SceneNode3d::empty(),
            },
            RuntimeBone {
                source_index: 7,
                parent_source_index: Some(2),
                label: "Hand".to_string(),
                node: SceneNode3d::empty(),
            },
        ];
        let actual = runtime_projection_text_next(
            STATIC_RUNTIME_SCENE_NODES,
            "hero",
            loaded.iter().map(|bone| {
                (
                    bone.source_index,
                    bone.parent_source_index,
                    bounded_runtime_label_len(&bone.label),
                )
            }),
        )
        .unwrap();
        assert_eq!(preflight_total, expected);
        assert_eq!(actual, expected);
    }

    #[test]
    fn gltf_projection_preflight_deduplicates_skins_and_matches_joint_parents() {
        let document = gltf::Gltf::from_slice(
            br#"{
                "asset": { "version": "2.0" },
                "nodes": [
                    { "name": "Root", "children": [1] },
                    { "children": [2] },
                    { "name": "Hand" }
                ],
                "skins": [
                    { "joints": [0, 1] },
                    { "joints": [1, 2] }
                ]
            }"#,
        )
        .unwrap()
        .document;
        let bones = gltf_projection_bones(&document);
        assert_eq!(
            bones,
            vec![
                GltfProjectionBone {
                    source_index: 0,
                    parent_source_index: None,
                    label_len: "Root".len(),
                },
                GltfProjectionBone {
                    source_index: 1,
                    parent_source_index: Some(0),
                    label_len: "Joint 2".len(),
                },
                GltfProjectionBone {
                    source_index: 2,
                    parent_source_index: Some(1),
                    label_len: "Hand".len(),
                },
            ]
        );
    }

    #[test]
    fn asset_source_budget_accepts_limit_and_rejects_overflow() {
        assert!(validate_asset_source_size(MAX_ASSET_SOURCE_BYTES).is_ok());
        let error = validate_asset_source_size(MAX_ASSET_SOURCE_BYTES + 1).unwrap_err();
        assert!(error.contains("asset source"));
        assert!(error.contains("limit"));
    }

    #[test]
    fn renderer_error_display_escapes_untrusted_path_and_message() {
        let error = RendererError::AssetLoad {
            instance_id: "hero\n1".to_string(),
            asset_id: "hero\tasset".to_string(),
            path: "C:\\assets\\hero\r.glb".to_string(),
            message: "decode\nfailed".to_string(),
        };
        let display = error.to_string();
        assert!(!display.contains('\n'));
        assert!(!display.contains('\r'));
        assert!(display.contains("hero\\n1"));
        assert!(display.contains("hero\\tasset"));
        assert!(display.contains("hero\\r.glb"));
        assert!(display.contains("decode\\nfailed"));
    }

    #[test]
    fn gltf_budget_rejects_image_and_accessor_collection_limits() {
        assert!(validate_gltf_budget(GltfBudgetUsage {
            declared_buffer_bytes: MAX_ASSET_SOURCE_BYTES,
            external_resource_bytes: 0,
            image_count: MAX_GLTF_IMAGES,
            accessor_elements: MAX_GLTF_ACCESSOR_ELEMENTS,
            accessor_bytes: 0,
        })
        .is_ok());

        let too_many_images = validate_gltf_budget(GltfBudgetUsage {
            declared_buffer_bytes: 0,
            external_resource_bytes: 0,
            image_count: MAX_GLTF_IMAGES + 1,
            accessor_elements: 0,
            accessor_bytes: 0,
        })
        .unwrap_err();
        assert!(too_many_images.contains("images"));

        let too_many_elements = validate_gltf_budget(GltfBudgetUsage {
            declared_buffer_bytes: 0,
            external_resource_bytes: 0,
            image_count: 0,
            accessor_elements: MAX_GLTF_ACCESSOR_ELEMENTS + 1,
            accessor_bytes: 0,
        })
        .unwrap_err();
        assert!(too_many_elements.contains("accessor"));

        let too_many_accessor_bytes = validate_gltf_budget(GltfBudgetUsage {
            declared_buffer_bytes: 0,
            external_resource_bytes: 0,
            image_count: 0,
            accessor_elements: 1,
            accessor_bytes: MAX_ASSET_SOURCE_BYTES + 1,
        })
        .unwrap_err();
        assert!(too_many_accessor_bytes.contains("accessor expansion"));
    }

    #[test]
    fn gltf_node_count_budget_matches_runtime_projection_cap() {
        assert!(validate_gltf_node_count(MAX_GLTF_NODES).is_ok());
        let error = validate_gltf_node_count(MAX_GLTF_NODES + 1)
            .expect_err("oversized node metadata must reject before projection allocation");
        assert!(error.contains("nodes"));
        assert!(error.contains("limit"));
        assert!(validate_gltf_skin_count(MAX_GLTF_SKINS).is_ok());
        let error = validate_gltf_skin_count(MAX_GLTF_SKINS + 1)
            .expect_err("oversized skin metadata must reject before projection allocation");
        assert!(error.contains("skins"));
        assert!(error.contains("limit"));
        assert!(validate_gltf_skin_joint_reference_values(MAX_GLTF_SKIN_JOINT_REFERENCES).is_ok());
        let error = validate_gltf_skin_joint_reference_values(MAX_GLTF_SKIN_JOINT_REFERENCES + 1)
            .expect_err("duplicated skinned-node joint data must reject before vendor loading");
        assert!(error.contains("joint references"));
        assert!(validate_gltf_bone_count(MAX_BONES_PER_INSTANCE).is_ok());
        let error = validate_gltf_bone_count(MAX_BONES_PER_INSTANCE + 1)
            .expect_err("oversized skeleton must reject before vendor loading");
        assert!(error.contains("skeleton"));
        assert!(error.contains("maximum"));
    }

    #[test]
    fn gltf_mesh_count_budget_matches_vendor_collection_limits() {
        let document = gltf::Gltf::from_slice(
            br#"{
                "asset": { "version": "2.0" },
                "meshes": [{ "primitives": [] }]
            }"#,
        )
        .unwrap()
        .document;
        assert!(validate_gltf_mesh_counts(&document).is_ok());
        assert!(validate_gltf_mesh_count_values(MAX_GLTF_MESHES, MAX_GLTF_PRIMITIVES).is_ok());
        assert!(validate_gltf_mesh_count_values(MAX_GLTF_MESHES + 1, 0).is_err());
        assert!(validate_gltf_mesh_count_values(0, MAX_GLTF_PRIMITIVES + 1).is_err());
        assert!(validate_gltf_material_count(MAX_GLTF_MATERIALS).is_ok());
        assert!(validate_gltf_material_count(MAX_GLTF_MATERIALS + 1).is_err());
        assert!(validate_gltf_animation_counts(&document).is_ok());
    }

    #[test]
    fn gltf_animation_count_budget_matches_vendor_collection_limits() {
        assert!(validate_gltf_animation_count_values(
            MAX_GLTF_ANIMATIONS,
            MAX_GLTF_ANIMATION_CHANNELS
        )
        .is_ok());

        let too_many_animations = validate_gltf_animation_count_values(
            MAX_GLTF_ANIMATIONS + 1,
            MAX_GLTF_ANIMATION_CHANNELS,
        )
        .expect_err("oversized animation metadata must reject before vendor loading");
        assert!(too_many_animations.contains("animations"));

        let too_many_channels = validate_gltf_animation_count_values(
            MAX_GLTF_ANIMATIONS,
            MAX_GLTF_ANIMATION_CHANNELS + 1,
        )
        .expect_err("oversized animation channels must reject before vendor loading");
        assert!(too_many_channels.contains("animation channels"));

        assert!(validate_gltf_animation_key_values(
            MAX_GLTF_ANIMATION_KEY_VALUES,
            MAX_GLTF_ANIMATION_KEY_VALUES,
        )
        .is_ok());
        let too_many_inputs = validate_gltf_animation_key_values(
            MAX_GLTF_ANIMATION_KEY_VALUES + 1,
            MAX_GLTF_ANIMATION_KEY_VALUES,
        )
        .expect_err("oversized animation inputs must reject before vendor loading");
        assert!(too_many_inputs.contains("animation inputs"));
        let too_many_outputs = validate_gltf_animation_key_values(
            MAX_GLTF_ANIMATION_KEY_VALUES,
            MAX_GLTF_ANIMATION_KEY_VALUES + 1,
        )
        .expect_err("oversized animation outputs must reject before vendor loading");
        assert!(too_many_outputs.contains("animation outputs"));
    }

    #[test]
    fn gltf_external_resource_budget_counts_sparse_buffers_and_images() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-gltf-resource-budget-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("fixture.gltf");
        let buffer_path = root.join("huge.bin");
        let image_path = root.join("huge.png");
        std::fs::write(
            &path,
            br#"{
  "asset": { "version": "2.0" },
  "buffers": [{ "uri": "huge.bin", "byteLength": 1 }],
  "images": [{ "uri": "huge.png" }]
}"#,
        )
        .expect("write glTF fixture");
        std::fs::File::create(&buffer_path)
            .expect("create sparse buffer")
            .set_len(1)
            .expect("size sparse buffer");
        std::fs::File::create(&image_path)
            .expect("create sparse image")
            .set_len(MAX_ASSET_SOURCE_BYTES + 1)
            .expect("size sparse image");

        let error = validate_runtime_asset_source(&path, "gltf")
            .expect_err("external resources must share the asset budget");
        assert!(error.contains("external resources"));
        assert!(error.contains("limit"));

        std::fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn glb_json_chunk_budget_rejects_before_allocating_declared_chunk() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-glb-json-budget-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("oversized.glb");
        let declared_json_length = (MAX_GLTF_JSON_BYTES + 1) as u32;
        let mut bytes = Vec::with_capacity(20);
        bytes.extend_from_slice(b"glTF");
        bytes.extend_from_slice(&2_u32.to_le_bytes());
        bytes.extend_from_slice(&20_u32.to_le_bytes());
        bytes.extend_from_slice(&declared_json_length.to_le_bytes());
        bytes.extend_from_slice(b"JSON");
        std::fs::write(&path, bytes).expect("write malformed GLB header");

        let error = open_gltf_document(&path)
            .expect_err("oversized JSON chunk must fail before allocation/read");
        assert!(error.contains("JSON chunk"));
        assert!(error.contains("limit"));
        std::fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn gltf_json_source_budget_rejects_before_parser_read() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-gltf-json-budget-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("oversized.gltf");
        let file = std::fs::File::create(&path).expect("create sparse glTF source");
        file.set_len(MAX_GLTF_JSON_BYTES + 1)
            .expect("size sparse glTF source");

        let error = open_gltf_document(&path)
            .expect_err("oversized JSON source must fail before parser read");
        assert!(error.contains("JSON document"));
        assert!(error.contains("limit"));
        std::fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn runtime_instance_budget_accepts_boundary_and_rejects_overflow() {
        let (scene, resolved) = runtime_budget_fixture(&[MAX_RUNTIME_INSTANCES_PER_ASSET]);
        assert!(validate_runtime_instance_counts(&scene, &resolved).is_ok());

        let (scene, resolved) = runtime_budget_fixture(&[MAX_RUNTIME_INSTANCES_PER_ASSET + 1]);
        let error = validate_runtime_instance_counts(&scene, &resolved).unwrap_err();
        match error {
            RendererError::AssetInstanceLimit {
                asset_id,
                path,
                instances,
                limit,
            } => {
                assert_eq!(asset_id, "asset-0");
                assert_eq!(path, "asset-0.glb");
                assert_eq!(instances, MAX_RUNTIME_INSTANCES_PER_ASSET + 1);
                assert_eq!(limit, MAX_RUNTIME_INSTANCES_PER_ASSET);
            }
            other => panic!("unexpected renderer error: {other}"),
        }
    }

    #[test]
    fn runtime_instance_budget_is_per_asset() {
        let (scene, resolved) = runtime_budget_fixture(&[33, 32]);
        assert!(validate_runtime_instance_counts(&scene, &resolved).is_ok());
    }

    #[test]
    fn runtime_instance_budget_preserves_missing_reference_error() {
        let (mut scene, resolved) = runtime_budget_fixture(&[1]);
        scene.instances[0].asset = "missing".to_string();
        let error = validate_runtime_instance_counts(&scene, &resolved).unwrap_err();
        assert!(matches!(
            error,
            RendererError::MissingResolvedAsset {
                asset_id,
                instance_id
            } if asset_id == "missing" && instance_id == "instance-0-0"
        ));
    }

    #[test]
    fn runtime_projection_summary_uses_instance_id_without_cube() {
        let mut root = SceneNode3d::empty();
        root.set_visible(false);
        let mut summaries = Vec::new();
        append_runtime_instance_summaries(
            &mut summaries,
            &RuntimeInstance {
                id: "box-instance".to_string(),
                root,
                player: AnimationPlayer::new(Vec::new()),
                bone_edges: Vec::new(),
                bones: Vec::new(),
            },
        );
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
        let mut hidden_bone = SceneNode3d::empty();
        hidden_bone.set_visible(false);
        let mut summaries = Vec::new();
        append_runtime_instance_summaries(
            &mut summaries,
            &RuntimeInstance {
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
                        node: hidden_bone,
                    },
                ],
            },
        );

        assert_eq!(summaries[1].id, "character::bone::4");
        assert_eq!(summaries[1].parent.as_deref(), Some("character"));
        assert_eq!(summaries[1].kind, "bone");
        assert_eq!(summaries[2].id, "character::bone::9");
        assert_eq!(summaries[2].parent.as_deref(), Some("character::bone::4"));
        assert!(!summaries[2].visible);
    }

    #[test]
    fn runtime_projection_bounds_unicode_bone_labels_for_wire() {
        let mut root = SceneNode3d::empty();
        root.set_visible(true);
        let long_label = "界".repeat(MAX_RUNTIME_LABEL_BYTES);
        let mut summaries = Vec::new();
        append_runtime_instance_summaries(
            &mut summaries,
            &RuntimeInstance {
                id: "character".to_string(),
                root,
                player: AnimationPlayer::new(Vec::new()),
                bone_edges: Vec::new(),
                bones: vec![RuntimeBone {
                    source_index: 0,
                    parent_source_index: None,
                    label: long_label.clone(),
                    node: SceneNode3d::empty(),
                }],
            },
        );

        let label = &summaries[1].label;
        assert!(long_label.len() > MAX_RUNTIME_LABEL_BYTES);
        assert!(label.len() <= MAX_RUNTIME_LABEL_BYTES);
        assert!(label.ends_with('…'));
        assert!(label.is_char_boundary(label.len()));
    }

    fn animated_player(name: &str) -> AnimationPlayer {
        let target = SceneNode3d::empty();
        let channel = AnimationChannel::translation(
            target,
            vec![0.0, 1.0],
            vec![Vec3::ZERO, Vec3::X],
            Interpolation::Linear,
        );
        AnimationPlayer::new(vec![AnimationClip::new(name.to_string(), vec![channel])])
    }

    fn runtime_instance(id: &str, player: AnimationPlayer) -> RuntimeInstance {
        RuntimeInstance {
            id: id.to_string(),
            root: SceneNode3d::empty(),
            player,
            bone_edges: Vec::new(),
            bones: Vec::new(),
        }
    }

    #[test]
    fn timeline_target_prefers_requested_instance_and_falls_back_to_first() {
        let instances = vec![
            runtime_instance("first", animated_player("first-clip")),
            runtime_instance("second", animated_player("second-clip")),
        ];
        let requested = ("second".to_string(), 0);
        let (instance, clip_index) =
            resolve_timeline_playback_target(&instances, Some(&requested)).unwrap();
        assert_eq!(instance.id, "second");
        assert_eq!(clip_index, 0);

        let missing = ("missing".to_string(), 0);
        let (instance, clip_index) =
            resolve_timeline_playback_target(&instances, Some(&missing)).unwrap();
        assert_eq!(instance.id, "first");
        assert_eq!(clip_index, 0);
        assert_eq!(
            first_timeline_playback_target(&instances),
            Some(("first".to_string(), 0))
        );
    }

    #[test]
    fn bone_edge_visibility_requires_scene_instance_and_both_endpoints() {
        assert!(bone_edge_is_visible(true, true, true, true));
        assert!(!bone_edge_is_visible(false, true, true, true));
        assert!(!bone_edge_is_visible(true, false, true, true));
        assert!(!bone_edge_is_visible(true, true, false, true));
        assert!(!bone_edge_is_visible(true, true, true, false));
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
    fn manipulator_projection_stays_in_css_pixels_across_dpr() {
        let camera = CameraState {
            target: [0.0, 0.0, 0.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        };
        let rect = |scale_factor| ViewportRect {
            x: 220.0,
            y: 24.0,
            width: 780.0,
            height: 664.0,
            scale_factor,
        };
        let (origin_1x, axes_1x) = projected_manipulator_axes(
            Vec3::ZERO,
            editable_transform(),
            ManipulatorOrientation::World,
            camera,
            CameraSettings::default(),
            rect(1.0),
        )
        .unwrap();
        let (origin_2x, axes_2x) = projected_manipulator_axes(
            Vec3::ZERO,
            editable_transform(),
            ManipulatorOrientation::World,
            camera,
            CameraSettings::default(),
            rect(2.0),
        )
        .unwrap();
        assert!(origin_1x.distance(Vec2::new(390.0, 332.0)) < 0.001);
        assert!(origin_1x.distance(origin_2x) < 0.001);
        assert_eq!(axes_1x.len(), axes_2x.len());
        for (left, right) in axes_1x.iter().zip(&axes_2x) {
            assert!(left.screen_direction.distance(right.screen_direction) < 0.0001);
            assert!((left.pixels_per_world_unit - right.pixels_per_world_unit).abs() < 0.0001);
        }
    }

    #[test]
    fn manipulator_hit_distance_covers_axis_segment_only() {
        let start = Vec2::new(100.0, 100.0);
        let end = Vec2::new(172.0, 100.0);
        assert!((point_segment_distance(Vec2::new(140.0, 106.0), start, end) - 6.0).abs() < 0.001);
        assert!(point_segment_distance(Vec2::new(190.0, 100.0), start, end) > 10.0);
    }

    #[test]
    fn manipulator_handle_priority_prefers_center_then_plane_then_axis() {
        let signature = ManipulatorViewSignature {
            camera_target: [0.0; 3],
            camera_yaw: 0.0,
            camera_pitch: 0.0,
            camera_distance: 4.0,
            projection: CameraProjection::Perspective,
            fov_degrees: 45.0,
            rect: ViewportRect {
                x: 0.0,
                y: 0.0,
                width: 640.0,
                height: 480.0,
                scale_factor: 1.0,
            },
        };
        let axis = ProjectedManipulatorAxis {
            index: 0,
            world_axis: Vec3::X,
            screen_direction: Vec2::X,
            pixels_per_world_unit: 40.0,
        };
        let plane = ProjectedManipulatorPlane {
            world_axes: [Vec3::X, Vec3::Y],
            screen_axes: [Vec2::X * 40.0, Vec2::Y * 40.0],
            pixels_per_world_unit: [40.0, 40.0],
        };
        let handles = vec![
            ProjectedManipulatorHandle {
                kind: ManipulatorHandleKind::Axis(0),
                world_points: vec![Vec3::ZERO, Vec3::X],
                hit: ManipulatorHitShape::Segment(Vec2::new(0.0, 0.0), Vec2::new(80.0, 0.0)),
                axis: Some(axis),
                plane: None,
            },
            ProjectedManipulatorHandle {
                kind: ManipulatorHandleKind::Plane(0, 1),
                world_points: vec![Vec3::ZERO; 4],
                hit: ManipulatorHitShape::Polygon(vec![
                    Vec2::new(-10.0, -10.0),
                    Vec2::new(10.0, -10.0),
                    Vec2::new(10.0, 10.0),
                    Vec2::new(-10.0, 10.0),
                ]),
                axis: None,
                plane: Some(plane),
            },
            ProjectedManipulatorHandle {
                kind: ManipulatorHandleKind::Center,
                world_points: vec![Vec3::ZERO; 4],
                hit: ManipulatorHitShape::Circle {
                    center: Vec2::ZERO,
                    radius: 9.0,
                },
                axis: None,
                plane: Some(plane),
            },
        ];
        let view = ManipulatorView {
            node_id: CUBE_ID.to_string(),
            mode: ManipulatorMode::Translate,
            signature,
            origin: Vec3::ZERO,
            screen_origin: Vec2::ZERO,
            axes: vec![axis],
            rings: Vec::new(),
            handles,
            line_width: 2.5,
            world_units_per_css_px: 1.0,
        };
        assert_eq!(
            pick_manipulator_handle(&view, Vec2::ZERO).unwrap().kind,
            ManipulatorHandleKind::Center
        );
        assert_eq!(
            pick_manipulator_handle(&view, Vec2::new(10.0, 10.0))
                .unwrap()
                .kind,
            ManipulatorHandleKind::Plane(0, 1)
        );
        assert_eq!(
            pick_manipulator_handle(&view, Vec2::new(40.0, 0.0))
                .unwrap()
                .kind,
            ManipulatorHandleKind::Axis(0)
        );
    }

    #[test]
    fn plane_translation_solves_two_axis_screen_delta() {
        let plane = ProjectedManipulatorPlane {
            world_axes: [Vec3::X, Vec3::Y],
            screen_axes: [Vec2::X * 40.0, Vec2::Y * 20.0],
            pixels_per_world_unit: [40.0, 20.0],
        };
        let coefficients = solve_plane_screen_delta(Vec2::new(80.0, -40.0), plane);
        assert!((coefficients[0] - 2.0).abs() < 0.0001);
        assert!((coefficients[1] + 2.0).abs() < 0.0001);
        let (_, transform) = manipulator_drag_transform(
            ManipulatorDrag::TranslatePlane {
                node_id: CUBE_ID.to_string(),
                kind: ManipulatorHandleKind::Plane(0, 1),
                plane,
                start_pointer: Vec2::ZERO,
                start_transform: editable_transform(),
                snap: true,
                snap_increment: 0.5,
            },
            Vec2::new(80.0, -40.0),
        );
        assert_eq!(transform.translation, [2.0, -2.0, 0.0]);
    }

    #[test]
    fn plane_screen_delta_degenerate_fallback_uses_squared_pixels_per_unit() {
        let plane = ProjectedManipulatorPlane {
            world_axes: [Vec3::X, Vec3::Y],
            // Nearly edge-on: both projected axes point almost in the same
            // direction, so the 2x2 solve deliberately takes its fallback.
            screen_axes: [Vec2::X * 40.0, Vec2::new(40.0, 0.00001)],
            pixels_per_world_unit: [40.0, 40.0],
        };
        let coefficients = solve_plane_screen_delta(Vec2::new(40.0, 0.0), plane);
        assert!((coefficients[0] - 1.0).abs() < 0.0001);
        assert!((coefficients[1] - 1.0).abs() < 0.0001);
    }

    #[test]
    fn snapped_local_plane_translation_stays_in_the_captured_plane() {
        let rotation = Quat::from_rotation_y(0.7) * Quat::from_rotation_z(0.4);
        let world_axes = [rotation * Vec3::X, rotation * Vec3::Y];
        let plane = ProjectedManipulatorPlane {
            world_axes,
            screen_axes: [Vec2::X * 40.0, Vec2::Y * 40.0],
            pixels_per_world_unit: [40.0, 40.0],
        };
        let (_, transform) = manipulator_drag_transform(
            ManipulatorDrag::TranslatePlane {
                node_id: CUBE_ID.to_string(),
                kind: ManipulatorHandleKind::Plane(0, 1),
                plane,
                start_pointer: Vec2::ZERO,
                start_transform: editable_transform(),
                snap: true,
                snap_increment: 0.5,
            },
            Vec2::new(24.0, 32.0),
        );
        let translation = Vec3::from_array(transform.translation);
        let normal = world_axes[0].cross(world_axes[1]).normalize();
        assert!(normal.dot(translation).abs() < 0.0001);
    }

    #[test]
    fn manipulator_overlay_width_scales_with_dpr_but_keeps_css_size() {
        let css_width = MANIPULATOR_SHAFT_WIDTH_PX;
        let physical_1x = manipulator_physical_width(css_width, 1.0);
        let physical_2x = manipulator_physical_width(css_width, 2.0);
        assert!((physical_1x - css_width).abs() < 0.0001);
        assert!((physical_2x - css_width * 2.0).abs() < 0.0001);
        assert!((physical_1x / 1.0 - physical_2x / 2.0).abs() < 0.0001);
    }

    #[test]
    fn manipulator_axes_share_one_world_scale_and_foreshorten_with_view() {
        let camera = CameraState {
            target: [0.0, 0.0, 0.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        };
        let settings = CameraSettings::default();
        let rect = ViewportRect {
            x: 0.0,
            y: 0.0,
            width: 640.0,
            height: 480.0,
            scale_factor: 1.0,
        };
        let (screen_origin, axes) = projected_manipulator_axes(
            Vec3::ZERO,
            editable_transform(),
            ManipulatorOrientation::World,
            camera,
            settings,
            rect,
        )
        .unwrap();
        let world_units_per_css_px =
            manipulator_world_units_per_css_px(Vec3::ZERO, camera, settings, rect).unwrap();
        let handles = projected_manipulator_handles(
            ManipulatorMode::Translate,
            Vec3::ZERO,
            screen_origin,
            &axes,
            &[],
            ManipulatorProjectionContext {
                camera,
                settings,
                rect,
                world_units_per_css_px,
            },
        );
        let axis_handles = handles
            .iter()
            .filter(|handle| matches!(handle.kind, ManipulatorHandleKind::Axis(_)))
            .collect::<Vec<_>>();
        assert_eq!(axis_handles.len(), 3);
        let expected_world_length = MANIPULATOR_LENGTH_CSS_PX * world_units_per_css_px;
        for handle in axis_handles {
            let world_length = handle.world_points[0].distance(handle.world_points[1]);
            assert!((world_length - expected_world_length).abs() < 0.0001);
            let screen_end =
                project_world_to_viewport(handle.world_points[1], camera, settings, rect).unwrap();
            assert!(screen_end.distance(screen_origin) < 100.0);
        }
    }

    #[test]
    fn manipulator_visual_palette_and_cone_density_are_high_contrast() {
        for color in [X_AXIS_COLOR, Y_AXIS_COLOR, Z_AXIS_COLOR] {
            assert_eq!(color.a, 1.0);
            assert!(color.r.max(color.g).max(color.b) >= 0.95);
        }
    }

    #[test]
    fn uniform_scale_multiplies_all_components_and_preserves_ratio() {
        let mut start = editable_transform();
        start.scale = [2.0, 3.0, 4.0];
        let (_, transform) = manipulator_drag_transform(
            ManipulatorDrag::ScaleUniform {
                node_id: CUBE_ID.to_string(),
                start_pointer: Vec2::ZERO,
                screen_direction: Vec2::X,
                start_transform: start,
                snap: false,
                snap_increment: 0.1,
            },
            Vec2::new(MANIPULATOR_LENGTH_CSS_PX, 0.0),
        );
        let factor = std::f32::consts::E;
        assert!((transform.scale[0] / 2.0 - factor).abs() < 0.0001);
        assert!((transform.scale[1] / 3.0 - factor).abs() < 0.0001);
        assert!((transform.scale[2] / 4.0 - factor).abs() < 0.0001);
    }

    #[test]
    fn view_ring_is_outer_and_uses_camera_forward_axis() {
        let camera = CameraState {
            target: [0.0, 0.0, 0.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        };
        let settings = CameraSettings::default();
        let rect = ViewportRect {
            x: 0.0,
            y: 0.0,
            width: 640.0,
            height: 480.0,
            scale_factor: 1.0,
        };
        let (origin, _axes) = projected_manipulator_axes(
            Vec3::ZERO,
            editable_transform(),
            ManipulatorOrientation::World,
            camera,
            settings,
            rect,
        )
        .unwrap();
        let world_units_per_css_px =
            manipulator_world_units_per_css_px(Vec3::ZERO, camera, settings, rect).unwrap();
        let view_ring = projected_view_rotation_ring(
            Vec3::ZERO,
            world_units_per_css_px,
            camera,
            settings,
            rect,
        )
        .unwrap();
        assert!(view_ring.is_view);
        assert_eq!(view_ring.index, 3);
        let (_, _, forward) = camera_view_basis(camera);
        assert!(view_ring.world_axis.distance(forward) < 0.0001);
        let outer_radius = view_ring
            .screen_points
            .iter()
            .map(|point| point.distance(origin))
            .fold(0.0, f32::max);
        let outer_min_radius = view_ring
            .screen_points
            .iter()
            .map(|point| point.distance(origin))
            .fold(f32::INFINITY, f32::min);
        assert!(outer_radius > 75.0);
        assert!(outer_min_radius > 75.0);
    }

    #[test]
    fn view_ring_drag_follows_screen_direction_instead_of_axis_ring_sign() {
        let start = Vec2::X;
        let projected_tangent = Vec2::NEG_Y;
        let axis_ring_sign = rotation_drag_angle_sign(start, projected_tangent, false);
        let view_ring_sign = rotation_drag_angle_sign(start, projected_tangent, true);

        assert_eq!(axis_ring_sign, -1.0);
        assert_eq!(view_ring_sign, 1.0);
        let clockwise_screen_delta = signed_arc_angle(start, Vec2::Y).unwrap();
        assert!(clockwise_screen_delta * view_ring_sign > 0.0);
    }

    fn editable_transform() -> ProjectionTransform {
        ProjectionTransform {
            translation: [0.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
        }
    }

    #[test]
    fn rotate_drag_applies_world_axis_delta_and_keeps_unit_quaternion() {
        let drag = ManipulatorDrag::Rotate {
            node_id: "cube".into(),
            kind: ManipulatorHandleKind::RotateAxis(1),
            world_axis: Vec3::Y,
            rotation_center: Vec2::ZERO,
            last_vector: Vec2::new(50.0, 0.0),
            angle_sign: 1.0,
            accumulated_angle: 1.0,
            start_transform: editable_transform(),
            snap: false,
            snap_increment: 1.0,
        };
        let (_, transform) = manipulator_drag_transform(drag, Vec2::new(50.0, 0.0));
        let rotation = Quat::from_array(transform.rotation);
        let expected = Quat::from_axis_angle(Vec3::Y, 1.0);
        assert!(rotation.dot(expected).abs() > 0.9999);
        assert!((rotation.length() - 1.0).abs() < 0.0001);
    }

    #[test]
    fn rotate_drag_accumulates_large_arcs_without_tangent_wrap() {
        let first = signed_arc_angle(Vec2::X, Vec2::Y).unwrap();
        let second = signed_arc_angle(Vec2::Y, -Vec2::X).unwrap();
        let angle = first + second;
        assert!((angle - std::f32::consts::PI).abs() < 0.0001);

        // Screen-space y points down, so a ring whose increasing tangent
        // starts at its top edge needs the opposite atan2 sign.
        let top = Vec2::new(0.0, -1.0);
        let tangent = Vec2::new(-1.0, 0.0);
        let sign = cross_2d(top, tangent).signum();
        assert!(
            (signed_arc_angle(top, tangent).unwrap() * sign - std::f32::consts::FRAC_PI_2).abs()
                < 0.0001
        );

        let drag = ManipulatorDrag::Rotate {
            node_id: "cube".into(),
            kind: ManipulatorHandleKind::RotateAxis(1),
            world_axis: Vec3::Y,
            rotation_center: Vec2::ZERO,
            last_vector: -Vec2::X,
            angle_sign: 1.0,
            accumulated_angle: angle,
            start_transform: editable_transform(),
            snap: false,
            snap_increment: 1.0,
        };
        let (_, transform) = manipulator_drag_transform(drag, -Vec2::X);
        let rotation = Quat::from_array(transform.rotation);
        let expected = Quat::from_axis_angle(Vec3::Y, std::f32::consts::PI);
        assert!(rotation.dot(expected).abs() > 0.9999);
    }

    #[test]
    fn manipulator_view_signature_changes_only_for_view_basis_inputs() {
        let camera = CameraState {
            target: [0.0, 0.0, 0.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        };
        let settings = CameraSettings::default();
        let rect = ViewportRect {
            x: 10.0,
            y: 20.0,
            width: 640.0,
            height: 480.0,
            scale_factor: 1.5,
        };
        let baseline = ManipulatorViewSignature::new(camera, settings, rect);
        assert_eq!(
            baseline,
            ManipulatorViewSignature::new(camera, settings, rect)
        );

        let mut changed_camera = camera;
        changed_camera.yaw += 0.1;
        assert_ne!(
            baseline,
            ManipulatorViewSignature::new(changed_camera, settings, rect)
        );

        let mut changed_rect = rect;
        changed_rect.width += 1.0;
        assert_ne!(
            baseline,
            ManipulatorViewSignature::new(camera, settings, changed_rect)
        );

        // Object transform edits intentionally do not participate in this
        // signature, so an optimistic drag update keeps its original basis.
        assert_eq!(
            baseline,
            ManipulatorViewSignature::new(camera, settings, rect)
        );
    }

    #[test]
    fn manipulator_view_cache_invalidates_for_selection_and_display_state() {
        let camera = CameraState {
            target: [0.0, 0.0, 0.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        };
        let settings = CameraSettings::default();
        let rect = ViewportRect {
            x: 10.0,
            y: 20.0,
            width: 640.0,
            height: 480.0,
            scale_factor: 1.5,
        };
        let signature = ManipulatorViewSignature::new(camera, settings, rect);
        let node = ManipulatorNodeSignature {
            transform: editable_transform(),
            visible: true,
            scene_visible: true,
            transform_editable: true,
            material: Some(ManipulatorMaterialSignature {
                color: [1.0, 0.45, 0.1, 1.0],
                metallic: 0.0,
                roughness: 0.5,
            }),
        };
        let cache = ManipulatorViewCacheKey {
            node_id: Some(CUBE_ID.to_string()),
            mode: ManipulatorMode::Translate,
            orientation: ManipulatorOrientation::World,
            signature,
            node: Some(node.clone()),
        };

        assert!(cache_matches(
            &cache,
            Some(CUBE_ID),
            ManipulatorMode::Translate,
            ManipulatorOrientation::World,
            signature,
            Some(&node),
        ));

        let mut changed_transform = node.clone();
        changed_transform.transform.translation[0] = 1.0;
        assert!(!cache_matches(
            &cache,
            Some(CUBE_ID),
            ManipulatorMode::Translate,
            ManipulatorOrientation::World,
            signature,
            Some(&changed_transform),
        ));

        let mut hidden = node.clone();
        hidden.visible = false;
        assert!(!cache_matches(
            &cache,
            Some(CUBE_ID),
            ManipulatorMode::Translate,
            ManipulatorOrientation::World,
            signature,
            Some(&hidden),
        ));

        let mut hidden_scene = node.clone();
        hidden_scene.scene_visible = false;
        assert!(!manipulator_effective_visibility(
            hidden_scene.scene_visible,
            hidden_scene.visible,
        ));
        assert!(!cache_matches(
            &cache,
            Some(CUBE_ID),
            ManipulatorMode::Translate,
            ManipulatorOrientation::World,
            signature,
            Some(&hidden_scene),
        ));
        assert!(manipulator_effective_visibility(true, true));

        let mut changed_material = node.clone();
        changed_material
            .material
            .as_mut()
            .expect("cube material signature")
            .metallic = 0.75;
        assert!(!cache_matches(
            &cache,
            Some(CUBE_ID),
            ManipulatorMode::Translate,
            ManipulatorOrientation::World,
            signature,
            Some(&changed_material),
        ));

        let mut non_editable = node.clone();
        non_editable.transform_editable = false;
        assert!(!cache_matches(
            &cache,
            Some(CUBE_ID),
            ManipulatorMode::Translate,
            ManipulatorOrientation::World,
            signature,
            Some(&non_editable),
        ));

        assert!(!cache_matches(
            &cache,
            Some(KEY_LIGHT_ID),
            ManipulatorMode::Translate,
            ManipulatorOrientation::World,
            signature,
            Some(&node),
        ));
        assert!(!cache_matches(
            &cache,
            Some(CUBE_ID),
            ManipulatorMode::Rotate,
            ManipulatorOrientation::World,
            signature,
            Some(&node),
        ));
    }

    #[test]
    fn scale_drag_locks_every_axis_independently_and_stays_positive() {
        for selected_index in 0..3 {
            let axis = ProjectedManipulatorAxis {
                index: selected_index,
                world_axis: [Vec3::X, Vec3::Y, Vec3::Z][selected_index],
                screen_direction: Vec2::X,
                pixels_per_world_unit: 40.0,
            };
            let mut start = editable_transform();
            start.scale = [2.0, 3.0, 4.0];
            let drag = ManipulatorDrag::Scale {
                node_id: "cube".into(),
                axis,
                start_pointer: Vec2::ZERO,
                start_transform: start.clone(),
                snap: false,
                snap_increment: 0.1,
            };
            let (_, transform) =
                manipulator_drag_transform(drag, Vec2::new(MANIPULATOR_LENGTH_CSS_PX, 0.0));

            for index in 0..3 {
                if index == selected_index {
                    assert!(
                        (transform.scale[index] - start.scale[index] * std::f32::consts::E).abs()
                            < 0.0001
                    );
                } else {
                    assert_eq!(transform.scale[index], start.scale[index]);
                }
            }
        }
    }

    #[test]
    fn snap_scalar_rounds_translate_rotate_and_scale_increments() {
        assert_eq!(snap_scalar(0.49, 1.0), 0.0);
        assert_eq!(snap_scalar(0.51, 1.0), 1.0);
        assert!((snap_scalar(0.23, 0.1) - 0.2).abs() < 0.0001);
        assert!((snap_scalar(0.31, 15.0_f32.to_radians()) - 15.0_f32.to_radians()).abs() < 0.0001);
    }

    #[test]
    fn manipulator_drag_uses_captured_non_default_snap_increments() {
        let translate_axis = ProjectedManipulatorAxis {
            index: 0,
            world_axis: Vec3::X,
            screen_direction: Vec2::X,
            pixels_per_world_unit: 20.0,
        };
        let (_, translated) = manipulator_drag_transform(
            ManipulatorDrag::Translate {
                node_id: "cube".into(),
                axis: translate_axis,
                start_pointer: Vec2::ZERO,
                start_transform: editable_transform(),
                snap: true,
                snap_increment: 0.5,
            },
            Vec2::new(30.0, 0.0),
        );
        assert!((translated.translation[0] - 1.5).abs() < 0.0001);

        let (_, rotated) = manipulator_drag_transform(
            ManipulatorDrag::Rotate {
                node_id: "cube".into(),
                kind: ManipulatorHandleKind::RotateAxis(1),
                world_axis: Vec3::Y,
                rotation_center: Vec2::ZERO,
                last_vector: Vec2::X,
                angle_sign: 1.0,
                accumulated_angle: 0.68,
                start_transform: editable_transform(),
                snap: true,
                snap_increment: 0.2,
            },
            Vec2::X,
        );
        let rotation = Quat::from_array(rotated.rotation);
        assert!(rotation.dot(Quat::from_axis_angle(Vec3::Y, 0.6)).abs() > 0.9999);

        let scale_axis = ProjectedManipulatorAxis {
            index: 2,
            world_axis: Vec3::Z,
            screen_direction: Vec2::X,
            pixels_per_world_unit: 40.0,
        };
        let (_, scaled) = manipulator_drag_transform(
            ManipulatorDrag::Scale {
                node_id: "cube".into(),
                axis: scale_axis,
                start_pointer: Vec2::ZERO,
                start_transform: editable_transform(),
                snap: true,
                snap_increment: 0.25,
            },
            Vec2::new(MANIPULATOR_LENGTH_CSS_PX, 0.0),
        );
        assert!((scaled.scale[2] - 2.75).abs() < 0.0001);
    }

    #[test]
    fn local_manipulator_basis_follows_selected_rotation() {
        let transform = ProjectionTransform {
            translation: [0.0, 0.0, 0.0],
            rotation: Quat::from_rotation_y(std::f32::consts::FRAC_PI_2).to_array(),
            scale: [1.0, 1.0, 1.0],
        };
        let camera = CameraState {
            target: [0.0, 0.0, 0.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        };
        let rect = ViewportRect {
            x: 0.0,
            y: 0.0,
            width: 640.0,
            height: 480.0,
            scale_factor: 1.0,
        };
        let (_, axes) = projected_manipulator_axes(
            Vec3::ZERO,
            transform,
            ManipulatorOrientation::Local,
            camera,
            CameraSettings::default(),
            rect,
        )
        .unwrap();
        let x = axes.iter().find(|axis| axis.index == 0).unwrap();
        assert!(x.world_axis.distance(Vec3::NEG_Z) < 0.0001);
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
