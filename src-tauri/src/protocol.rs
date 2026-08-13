//! IPC data-transfer objects shared between the WebView and Rust.
//!
//! Kept dependency-free (serde only, no wgpu/tauri types) so the renderer
//! backend can be swapped without touching the wire format.

/// Rectangle (in CSS pixels, relative to the window's inner viewport) that
/// the frontend wants the native wgpu cube to be drawn into. Fixed IPC
/// contract shared with the web side.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewportRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub scale_factor: f32,
}

/// Active native transform manipulator. This is transient editor state: the
/// authored result is persisted in Scene transforms, while the selected tool
/// itself resets to Translate on startup.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ManipulatorMode {
    #[default]
    Translate,
    Rotate,
    Scale,
}

/// Transient basis used by the Native transform manipulator.  World keeps
/// the canonical XYZ axes; Local rotates those axes by the selected root
/// object's local rotation.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ManipulatorOrientation {
    #[default]
    World,
    Local,
}

/// Editor-only snapping increments.  `enabled` is toggled by the viewport
/// toolbar; holding Shift while pressing a hit handle also enables snapping
/// for that gesture.  Values are deliberately small and bounded at the IPC
/// boundary so malformed settings cannot poison manipulator arithmetic.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManipulatorSnapSettings {
    pub enabled: bool,
    pub translate_increment: f32,
    pub rotate_degrees: f32,
    pub scale_increment: f32,
}

impl Default for ManipulatorSnapSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            translate_increment: 1.0,
            rotate_degrees: 15.0,
            scale_increment: 0.1,
        }
    }
}

/// Editor-only Native viewport display flags. These are deliberately kept out
/// of Scene JSON; the WebView persists them through its versioned Settings
/// envelope while Native remains authoritative for the active renderer.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CameraProjection {
    #[default]
    Perspective,
    Orthographic,
}

/// View orientations offered by the Native viewport Camera menu.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CameraViewPreset {
    Front,
    Right,
    Top,
    #[default]
    Perspective,
}

/// Transient editor camera settings. Projection and FOV are persisted by the
/// WebView's versioned editor settings; the view preset is intentionally an
/// action rather than Scene data.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewportTonemap {
    #[default]
    None,
    Reinhard,
    Aces,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewportBackgroundMode {
    #[default]
    Transparent,
    Solid,
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
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
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
    /// Terminates the current pointer gesture without applying a final move.
    /// This is used when the browser emits `pointercancel` or the ViewportHost
    /// detaches during a Native/Canvas backend switch.
    PointerCancel,
    Wheel {
        dx: f32,
        dy: f32,
        modifiers: u16,
    },
}

const MAX_VIEWPORT_COORDINATE: f32 = 1_000_000.0;
const MAX_VIEWPORT_WHEEL_DELTA: f32 = 100_000.0;

impl ViewportInput {
    /// Validate transient pointer data before it reaches camera/manipulator
    /// arithmetic. These bounds are deliberately generous for CSS pixels and
    /// browser wheel deltas while rejecting non-finite or overflow-prone IPC.
    pub(crate) fn validate(&self) -> Result<(), String> {
        fn coordinate(value: f32, name: &str) -> Result<(), String> {
            if !value.is_finite() {
                return Err(format!("viewport input {name} must be finite"));
            }
            if value.abs() > MAX_VIEWPORT_COORDINATE {
                return Err(format!(
                    "viewport input {name} exceeds {MAX_VIEWPORT_COORDINATE} CSS px"
                ));
            }
            Ok(())
        }

        fn wheel_delta(value: f32, name: &str) -> Result<(), String> {
            if !value.is_finite() {
                return Err(format!("viewport input {name} must be finite"));
            }
            if value.abs() > MAX_VIEWPORT_WHEEL_DELTA {
                return Err(format!(
                    "viewport input {name} exceeds {MAX_VIEWPORT_WHEEL_DELTA}"
                ));
            }
            Ok(())
        }

        match self {
            Self::PointerMove { x, y, .. }
            | Self::PointerDown { x, y, .. }
            | Self::PointerUp { x, y, .. } => {
                coordinate(*x, "x")?;
                coordinate(*y, "y")
            }
            Self::PointerCancel => Ok(()),
            Self::Wheel { dx, dy, .. } => {
                wheel_delta(*dx, "wheel dx")?;
                wheel_delta(*dy, "wheel dy")
            }
        }
    }
}

/// Orbit camera state exchanged with the frontend so a Canvas (three.js)
/// fallback renderer can take over the viewport with camera continuity.
/// Fixed IPC contract shared with the web side.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug)]
#[serde(deny_unknown_fields)]
pub struct CameraState {
    pub target: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
}

#[cfg(test)]
mod viewport_input_tests {
    use super::{
        CameraSettings, CameraState, ViewportDisplaySettings, ViewportEnvironmentSettings,
        ViewportInput, ViewportLightingSettings, ViewportRect,
    };

    fn pointer_move(x: f32, y: f32) -> ViewportInput {
        ViewportInput::PointerMove {
            x,
            y,
            buttons: 1,
            modifiers: 0,
        }
    }

    #[test]
    fn accepts_normal_and_boundary_values() {
        assert!(pointer_move(1_000_000.0, -1_000_000.0).validate().is_ok());
        assert!(ViewportInput::Wheel {
            dx: 100_000.0,
            dy: -100_000.0,
            modifiers: 0,
        }
        .validate()
        .is_ok());
        assert!(ViewportInput::PointerCancel.validate().is_ok());
    }

    #[test]
    fn rejects_non_finite_and_out_of_range_values() {
        for input in [
            pointer_move(f32::NAN, 0.0),
            pointer_move(f32::INFINITY, 0.0),
            pointer_move(0.0, f32::NEG_INFINITY),
            pointer_move(1_000_001.0, 0.0),
            ViewportInput::Wheel {
                dx: f32::NAN,
                dy: 0.0,
                modifiers: 0,
            },
            ViewportInput::Wheel {
                dx: 0.0,
                dy: 100_001.0,
                modifiers: 0,
            },
        ] {
            assert!(
                input.validate().is_err(),
                "input should be rejected: {input:?}"
            );
        }
    }

    #[test]
    fn fixed_protocol_wire_rejects_unknown_fields() {
        fn rejects<T: serde::de::DeserializeOwned>(json: &str) {
            assert!(serde_json::from_str::<T>(json).is_err());
        }

        rejects::<ViewportRect>(
            r#"{"x":0.0,"y":0.0,"width":10.0,"height":10.0,"scaleFactor":1.0,"future":true}"#,
        );
        rejects::<ViewportInput>(
            r#"{"type":"pointerMove","x":0.0,"y":0.0,"buttons":1,"modifiers":0,"future":true}"#,
        );
        rejects::<ViewportDisplaySettings>(
            r#"{"mode":"lit","showGrid":true,"showBones":false,"future":true}"#,
        );
        rejects::<CameraSettings>(
            r#"{"projection":"perspective","fovDegrees":45.0,"future":true}"#,
        );
        rejects::<ViewportEnvironmentSettings>(
            r#"{"enabled":false,"path":"","rotationDegrees":0.0,"intensity":1.0,"future":true}"#,
        );
        rejects::<ViewportLightingSettings>(
            r#"{"exposure":1.0,"tonemap":"none","ambientIntensity":0.2,"ambientColor":[1.0,1.0,1.0],"shadowsEnabled":true,"shadowResolution":2048,"shadowSoftness":1.0,"backgroundMode":"transparent","backgroundColor":[0.0,0.0,0.0],"future":true}"#,
        );
        rejects::<CameraState>(
            r#"{"target":[0.0,0.0,0.0],"yaw":0.0,"pitch":0.0,"distance":5.0,"future":true}"#,
        );
    }
}
