//! Minimal orbit camera: pure glam math, no wgpu/tauri dependency, so the
//! renderer backend can be swapped without touching this file.

use glam::Vec3;

use crate::protocol::{CameraState, CameraViewPreset, ViewportInput};

const PITCH_LIMIT: f32 = 1.55;
const MIN_DISTANCE: f32 = 0.5;
const MAX_DISTANCE: f32 = 100.0;
const CAMERA_BASIS_EPSILON_SQ: f32 = f32::EPSILON;
const ORBIT_SPEED: f32 = 0.01;
const PAN_SPEED: f32 = 0.002;
const ZOOM_SPEED: f32 = 0.002;

const SHIFT: u16 = 1;
const MIDDLE_BUTTON: u8 = 1;
const LEFT_BUTTON: u8 = 0;

#[derive(Clone, Copy, PartialEq)]
enum DragMode {
    None,
    Orbit,
    Pan,
}

/// Simple yaw/pitch/distance-around-target orbit camera driven by
/// `ViewportInput` events forwarded from the WebView.
pub struct OrbitCamera {
    pub target: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    last_pos: (f32, f32),
    drag: DragMode,
}

impl Default for OrbitCamera {
    fn default() -> Self {
        OrbitCamera {
            target: Vec3::ZERO,
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
            last_pos: (0.0, 0.0),
            drag: DragMode::None,
        }
    }
}

impl OrbitCamera {
    /// Applies one input event, updating the internal drag state and the
    /// orbit/pan/zoom parameters.
    pub fn handle_input(&mut self, input: ViewportInput) {
        match input {
            ViewportInput::PointerDown {
                x,
                y,
                button,
                modifiers,
            } => {
                self.last_pos = (x, y);
                self.drag = if button == MIDDLE_BUTTON
                    || (button == LEFT_BUTTON && modifiers & SHIFT != 0)
                {
                    DragMode::Pan
                } else if button == LEFT_BUTTON {
                    DragMode::Orbit
                } else {
                    DragMode::None
                };
            }
            ViewportInput::PointerUp { .. } => self.drag = DragMode::None,
            ViewportInput::PointerCancel => self.drag = DragMode::None,
            ViewportInput::PointerMove { x, y, .. } => {
                let (dx, dy) = (x - self.last_pos.0, y - self.last_pos.1);
                self.last_pos = (x, y);
                match self.drag {
                    DragMode::Orbit => {
                        // Reversed per request: orbit direction negated on
                        // both axes relative to the raw pointer delta.
                        self.yaw += dx * ORBIT_SPEED;
                        self.pitch =
                            (self.pitch + dy * ORBIT_SPEED).clamp(-PITCH_LIMIT, PITCH_LIMIT);
                    }
                    DragMode::Pan => {
                        let (right, up) = self.basis();
                        let scale = self.distance * PAN_SPEED;
                        self.target -= right * dx * scale;
                        self.target += up * dy * scale;
                    }
                    DragMode::None => {}
                }
            }
            ViewportInput::Wheel { dy, .. } => {
                self.distance =
                    (self.distance * (dy * ZOOM_SPEED).exp()).clamp(MIN_DISTANCE, MAX_DISTANCE);
            }
        }
    }

    /// Snapshot of the camera state for handing off to a Canvas fallback
    /// renderer (see `CameraState`).
    pub fn state(&self) -> CameraState {
        CameraState {
            target: self.target.into(),
            yaw: self.yaw,
            pitch: self.pitch,
            distance: self.distance,
        }
    }

    /// Restores camera state (e.g. handed back from a Canvas fallback
    /// renderer), clearing any in-progress drag so the next input event
    /// starts clean.
    pub fn set_state(&mut self, state: CameraState) {
        self.target = state.target.into();
        self.yaw = state.yaw;
        self.pitch = state.pitch;
        self.distance = state.distance;
        self.drag = DragMode::None;
    }

    /// Apply a fixed orientation while retaining the current focus point and
    /// orbit distance. Presets are Native-only actions and deliberately do not
    /// become part of `CameraState`/Scene JSON.
    pub fn set_view_preset(&mut self, preset: CameraViewPreset) {
        const FRONT_YAW: f32 = -std::f32::consts::FRAC_PI_2;
        const RIGHT_YAW: f32 = 0.0;
        match preset {
            CameraViewPreset::Front => {
                self.yaw = FRONT_YAW;
                self.pitch = 0.0;
            }
            CameraViewPreset::Right => {
                self.yaw = RIGHT_YAW;
                self.pitch = 0.0;
            }
            CameraViewPreset::Top => {
                self.yaw = FRONT_YAW;
                self.pitch = PITCH_LIMIT;
            }
            CameraViewPreset::Perspective => {
                self.yaw = -0.6;
                self.pitch = 0.35;
            }
        }
        self.drag = DragMode::None;
    }

    fn eye(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        self.target + self.distance * Vec3::new(cp * cy, sp, cp * sy)
    }

    /// Right/up vectors of the current camera orientation, used for panning.
    fn basis(&self) -> (Vec3, Vec3) {
        let forward = (self.target - self.eye()).normalize_or_zero();
        let right = forward.cross(Vec3::Y).normalize_or_zero();
        let up = right.cross(forward);
        (right, up)
    }
}

/// Validates wire camera state before it reaches the renderer's f32
/// view/projection math. These bounds mirror the interactive orbit camera;
/// rejecting an out-of-range handoff keeps Scene load and IPC consistent with
/// pointer-driven camera updates.
pub(crate) fn validate_camera_state(state: &CameraState) -> Result<(), String> {
    if state.target.iter().any(|value| !value.is_finite())
        || !state.yaw.is_finite()
        || !state.pitch.is_finite()
        || !state.distance.is_finite()
    {
        return Err("Camera state must contain only finite values".into());
    }
    if state.pitch.abs() > PITCH_LIMIT {
        return Err(format!(
            "Camera pitch must be between -{PITCH_LIMIT} and {PITCH_LIMIT} radians"
        ));
    }
    if !(MIN_DISTANCE..=MAX_DISTANCE).contains(&state.distance) {
        return Err(format!(
            "Camera distance must be between {MIN_DISTANCE} and {MAX_DISTANCE}"
        ));
    }

    let target = Vec3::from_array(state.target);
    let (sin_yaw, cos_yaw) = state.yaw.sin_cos();
    let (sin_pitch, cos_pitch) = state.pitch.sin_cos();
    let eye =
        target + state.distance * Vec3::new(cos_pitch * cos_yaw, sin_pitch, cos_pitch * sin_yaw);
    let separation = eye - target;
    if !eye.is_finite()
        || !separation.is_finite()
        || separation.length_squared() <= CAMERA_BASIS_EPSILON_SQ
    {
        return Err("Camera state produces a degenerate view basis".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_presets_keep_target_and_distance() {
        let mut camera = OrbitCamera {
            target: Vec3::new(1.0, 2.0, 3.0),
            distance: 7.0,
            ..OrbitCamera::default()
        };

        camera.set_view_preset(CameraViewPreset::Top);
        assert_eq!(camera.target, Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(camera.distance, 7.0);
        assert!((camera.pitch - PITCH_LIMIT).abs() < f32::EPSILON);

        camera.set_view_preset(CameraViewPreset::Perspective);
        assert_eq!(camera.target, Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(camera.distance, 7.0);
        assert!((camera.yaw + 0.6).abs() < f32::EPSILON);
    }

    #[test]
    fn pointer_cancel_clears_drag_without_changing_camera_pose() {
        let mut camera = OrbitCamera::default();
        camera.handle_input(ViewportInput::PointerDown {
            x: 10.0,
            y: 20.0,
            button: LEFT_BUTTON,
            modifiers: 0,
        });
        let before = camera.state();

        camera.handle_input(ViewportInput::PointerCancel);
        camera.handle_input(ViewportInput::PointerMove {
            x: 90.0,
            y: 120.0,
            buttons: 1,
            modifiers: 0,
        });

        assert_eq!(camera.state().target, before.target);
        assert_eq!(camera.state().yaw, before.yaw);
        assert_eq!(camera.state().pitch, before.pitch);
        assert_eq!(camera.state().distance, before.distance);
    }

    #[test]
    fn rejects_camera_states_outside_orbit_bounds_or_with_degenerate_basis() {
        let valid = CameraState {
            target: [0.0, 0.0, 0.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        };
        assert!(validate_camera_state(&valid).is_ok());
        assert!(validate_camera_state(&CameraState {
            distance: MAX_DISTANCE + 1.0,
            ..valid
        })
        .is_err());
        assert!(validate_camera_state(&CameraState {
            pitch: PITCH_LIMIT + 0.01,
            ..valid
        })
        .is_err());
        assert!(validate_camera_state(&CameraState {
            target: [1.0e20, 0.0, 0.0],
            yaw: 0.0,
            pitch: 0.0,
            ..valid
        })
        .is_err());
    }
}
