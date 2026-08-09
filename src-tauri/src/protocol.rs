//! IPC data-transfer objects shared between the WebView and Rust.
//!
//! Kept dependency-free (serde only, no wgpu/tauri types) so the renderer
//! backend can be swapped without touching the wire format.

/// Rectangle (in CSS pixels, relative to the window's inner viewport) that
/// the frontend wants the native wgpu cube to be drawn into. Fixed IPC
/// contract shared with the web side.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewportRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub scale_factor: f32,
}

/// Editor-only Native viewport display flags. These are deliberately kept out
/// of Scene JSON; the WebView persists them through its versioned Settings
/// envelope while Native remains authoritative for the active renderer.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewportDisplaySettings {
    pub mode: ViewportDisplayMode,
    pub show_grid: bool,
    pub show_bones: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewportDisplayMode {
    Lit,
    Wireframe,
}

impl Default for ViewportDisplaySettings {
    fn default() -> Self {
        Self {
            mode: ViewportDisplayMode::Lit,
            show_grid: true,
            show_bones: false,
        }
    }
}

/// Editor-only camera projection. Kept separate from `CameraState` so Scene
/// JSON continues to serialize only target/orbit pose and Native↔Canvas
/// handoff remains backwards-compatible.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CameraProjection {
    Perspective,
    Orthographic,
}

impl Default for CameraProjection {
    fn default() -> Self {
        Self::Perspective
    }
}

/// View orientations offered by the Native viewport Camera menu.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CameraViewPreset {
    Front,
    Right,
    Top,
    Perspective,
}

impl Default for CameraViewPreset {
    fn default() -> Self {
        Self::Perspective
    }
}

/// Transient editor camera settings. Projection and FOV are persisted by the
/// WebView's versioned editor settings; the view preset is intentionally an
/// action rather than Scene data.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraSettings {
    pub projection: CameraProjection,
    pub fov_degrees: f32,
}

impl Default for CameraSettings {
    fn default() -> Self {
        Self {
            projection: CameraProjection::Perspective,
            fov_degrees: 45.0,
        }
    }
}

/// Editor-only equirectangular environment settings. The path is an absolute
/// local runtime input and deliberately remains outside Scene JSON.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewportEnvironmentSettings {
    pub enabled: bool,
    pub path: String,
    pub rotation_degrees: f32,
    pub intensity: f32,
}

impl Default for ViewportEnvironmentSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            path: String::new(),
            rotation_degrees: 0.0,
            intensity: 1.0,
        }
    }
}

/// Editor-only Native viewport lighting and background controls. These values
/// are persisted by the WebView settings envelope and never enter Scene JSON.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewportLightingSettings {
    pub exposure: f32,
    pub tonemap: ViewportTonemap,
    pub ambient_intensity: f32,
    pub ambient_color: [f32; 3],
    pub shadows_enabled: bool,
    pub shadow_resolution: u32,
    pub shadow_softness: f32,
    pub background_mode: ViewportBackgroundMode,
    pub background_color: [f32; 3],
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewportTonemap {
    None,
    Reinhard,
    Aces,
}

impl Default for ViewportTonemap {
    fn default() -> Self {
        Self::None
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewportBackgroundMode {
    Transparent,
    Solid,
}

impl Default for ViewportBackgroundMode {
    fn default() -> Self {
        Self::Transparent
    }
}

impl Default for ViewportLightingSettings {
    fn default() -> Self {
        Self {
            exposure: 1.0,
            tonemap: ViewportTonemap::None,
            ambient_intensity: 0.2,
            ambient_color: [1.0, 1.0, 1.0],
            shadows_enabled: true,
            shadow_resolution: 2048,
            shadow_softness: 1.0,
            background_mode: ViewportBackgroundMode::Transparent,
            background_color: [0.0, 0.0, 0.0],
        }
    }
}

/// Pointer/wheel input forwarded from the WebView's ViewportHost element via
/// the `viewport_input` command. Generic and extensible: a new input source
/// (keyboard, gamepad, ...) only needs a new variant here plus a match arm
/// in `OrbitCamera::handle_input`.
///
/// `x`/`y` are CSS px in ViewportHost-local coordinates (origin = host
/// top-left). `buttons` is the `PointerEvent.buttons` bitmask (1=left,
/// 4=middle); `button` is `PointerEvent.button` (0=left, 1=middle, 2=right).
/// `modifiers` is a bitfield: 1=Shift, 2=Ctrl, 4=Alt, 8=Meta.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(dead_code)] // fields are part of the fixed IPC contract; not all are read yet
pub enum ViewportInput {
    PointerMove {
        x: f32,
        y: f32,
        buttons: u16,
        modifiers: u16,
    },
    PointerDown {
        x: f32,
        y: f32,
        button: u8,
        modifiers: u16,
    },
    PointerUp {
        x: f32,
        y: f32,
        button: u8,
        modifiers: u16,
    },
    Wheel {
        dx: f32,
        dy: f32,
        modifiers: u16,
    },
}

/// Orbit camera state exchanged with the frontend so a Canvas (three.js)
/// fallback renderer can take over the viewport with camera continuity.
/// Fixed IPC contract shared with the web side.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug)]
pub struct CameraState {
    pub target: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
}
