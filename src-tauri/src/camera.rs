//! Minimal orbit camera: pure glam math, no wgpu/tauri dependency, so the
//! renderer backend can be swapped without touching this file.

use glam::{Mat4, Vec3};

use crate::protocol::{CameraState, ViewportInput};

const PITCH_LIMIT: f32 = 1.55;
const MIN_DISTANCE: f32 = 0.5;
const MAX_DISTANCE: f32 = 100.0;
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
            ViewportInput::PointerDown { x, y, button, modifiers } => {
                self.last_pos = (x, y);
                self.drag = if button == MIDDLE_BUTTON || (button == LEFT_BUTTON && modifiers & SHIFT != 0) {
                    DragMode::Pan
                } else if button == LEFT_BUTTON {
                    DragMode::Orbit
                } else {
                    DragMode::None
                };
            }
            ViewportInput::PointerUp { .. } => self.drag = DragMode::None,
            ViewportInput::PointerMove { x, y, .. } => {
                let (dx, dy) = (x - self.last_pos.0, y - self.last_pos.1);
                self.last_pos = (x, y);
                match self.drag {
                    DragMode::Orbit => {
                        // Reversed per request: orbit direction negated on
                        // both axes relative to the raw pointer delta.
                        self.yaw += dx * ORBIT_SPEED;
                        self.pitch = (self.pitch + dy * ORBIT_SPEED).clamp(-PITCH_LIMIT, PITCH_LIMIT);
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
                self.distance = (self.distance * (dy * ZOOM_SPEED).exp()).clamp(MIN_DISTANCE, MAX_DISTANCE);
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

    /// Builds the view-projection matrix for the given viewport aspect
    /// ratio, matching wgpu's [0, 1] NDC depth range (same helpers the
    /// renderer previously used directly).
    pub fn view_proj(&self, aspect: f32) -> Mat4 {
        let proj = glam::camera::rh::proj::directx::perspective(45f32.to_radians(), aspect, 0.1, 100.0);
        let view = glam::camera::rh::view::look_at_mat4(self.eye(), self.target, Vec3::Y);
        proj * view
    }
}
