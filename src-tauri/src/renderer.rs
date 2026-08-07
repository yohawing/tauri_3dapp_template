use kiss3d::prelude::{
    CanvasSetup, Light, NumSamples, OrbitCamera3d, Quat, SceneNode3d, Vec3, Window, BLACK, ORANGE,
};

use crate::protocol::{CameraState, ViewportRect};

/// Kiss3d scene hosted by the Tauri-owned native window.
///
/// Kiss3d deliberately keeps scene/window state single-threaded. The app owns
/// this value in thread-local storage on Tauri's event-loop thread; IPC only
/// shares the small camera/viewport DTOs.
pub struct Renderer {
    window: Window,
    scene: SceneNode3d,
    cube: SceneNode3d,
    camera: OrbitCamera3d,
    _viewport_px: (f32, f32, f32, f32),
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
        scene
            .add_light(Light::point(100.0))
            .set_position(Vec3::new(2.5, 3.0, -2.0));
        let cube = scene.add_cube(0.5, 0.5, 0.5).set_color(ORANGE);
        let camera = OrbitCamera3d::new(Vec3::new(3.0, 1.5, -3.0), Vec3::ZERO);

        Renderer {
            window: kiss_window,
            scene,
            cube,
            camera,
            _viewport_px: (0.0, 0.0, width as f32, height as f32),
        }
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
        let scale = rect.scale_factor.max(0.0);
        self._viewport_px = (
            rect.x * scale,
            rect.y * scale,
            rect.width * scale,
            rect.height * scale,
        );
    }

    pub fn render(&mut self) {
        self.cube.rotate(Quat::from_axis_angle(Vec3::Y, 0.006));
        let _ = pollster::block_on(self.window.render_3d(&mut self.scene, &mut self.camera));
    }
}

pub fn apply_viewport_rect(renderer: &mut Renderer, rect: ViewportRect) {
    renderer.set_viewport_rect(rect);
}
