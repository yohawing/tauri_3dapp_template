use kiss3d::color::Color;
use kiss3d::prelude::{
    CanvasSetup, Light, NumSamples, OrbitCamera3d, Quat, SceneNode3d, Vec3, Window, BLACK, ORANGE,
};

use crate::protocol::{CameraState, ViewportRect};
use crate::scene_projection::{
    SceneCommand, SceneMaterial, SceneNodeSummary, SceneProjection, SceneTransform,
    SelectedSceneNode,
};

pub const SCENE_ID: &str = "scene";
pub const KEY_LIGHT_ID: &str = "key-light";
pub const CUBE_ID: &str = "cube";

/// Kiss3d scene hosted by the Tauri-owned native window.
///
/// Kiss3d deliberately keeps scene/window state single-threaded. The app owns
/// this value in thread-local storage on Tauri's event-loop thread; IPC only
/// shares the small camera/viewport DTOs.
pub struct Renderer {
    window: Window,
    scene: SceneNode3d,
    key_light: SceneNode3d,
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
        let mut key_light = scene.add_light(Light::point(100.0));
        key_light.set_position(Vec3::new(2.5, 3.0, -2.0));
        let cube = scene.add_cube(0.5, 0.5, 0.5).set_color(ORANGE);
        let camera = OrbitCamera3d::new(Vec3::new(3.0, 1.5, -3.0), Vec3::ZERO);

        Renderer {
            window: kiss_window,
            scene,
            key_light,
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

    pub fn has_node(&self, node_id: &str) -> bool {
        matches!(node_id, SCENE_ID | KEY_LIGHT_ID | CUBE_ID)
    }

    pub fn apply_scene_command(&mut self, command: SceneCommand) -> bool {
        match command {
            SceneCommand::SetBaseColor { node_id, color } if node_id == CUBE_ID => {
                self.cube
                    .set_color(Color::new(color[0], color[1], color[2], color[3]));
            }
            SceneCommand::SetMetallic { node_id, value } if node_id == CUBE_ID => {
                self.cube.set_metallic(value);
            }
            SceneCommand::SetRoughness { node_id, value } if node_id == CUBE_ID => {
                self.cube.set_roughness(value);
            }
            _ => return false,
        }
        true
    }

    pub fn scene_projection(&self, selected_id: Option<&str>) -> SceneProjection {
        let selected_node_id = selected_id
            .filter(|id| self.has_node(id))
            .map(ToOwned::to_owned);

        let nodes = vec![
            SceneNodeSummary {
                id: SCENE_ID.to_string(),
                parent: None,
                label: "Scene".to_string(),
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
            SceneNodeSummary {
                id: CUBE_ID.to_string(),
                parent: Some(SCENE_ID.to_string()),
                label: "Cube".to_string(),
                kind: "mesh".to_string(),
                visible: self.cube.is_visible(),
            },
        ];

        let selected = selected_node_id
            .as_deref()
            .and_then(|id| self.selected_details(id));

        SceneProjection {
            revision: 0,
            selected_node_id,
            nodes,
            selected,
        }
    }

    fn selected_details(&self, node_id: &str) -> Option<SelectedSceneNode> {
        let node = match node_id {
            SCENE_ID => &self.scene,
            KEY_LIGHT_ID => &self.key_light,
            CUBE_ID => &self.cube,
            _ => return None,
        };
        let pose = node.local_transformation();
        let transform = SceneTransform {
            translation: pose.translation.to_array(),
            rotation: pose.rotation.to_array(),
            scale: node.local_scale().to_array(),
        };
        let material = if node_id == CUBE_ID {
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

pub fn apply_viewport_rect(renderer: &mut Renderer, rect: ViewportRect) {
    renderer.set_viewport_rect(rect);
}
