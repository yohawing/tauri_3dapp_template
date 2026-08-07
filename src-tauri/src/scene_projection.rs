//! The small serializable scene view used by the WebView panels.
//!
//! Kiss3d handles never cross this boundary.  The renderer builds a fresh DTO
//! from its event-loop-owned handles, while this store only keeps Send-safe
//! snapshots and pending edit requests from IPC.

use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SceneCommand {
    SetBaseColor { node_id: String, color: [f32; 4] },
    SetMetallic { node_id: String, value: f32 },
    SetRoughness { node_id: String, value: f32 },
}

impl SceneCommand {
    fn validate(&self) -> Result<(), String> {
        let values: &[f32] = match self {
            Self::SetBaseColor { color, .. } => color,
            Self::SetMetallic { value, .. } | Self::SetRoughness { value, .. } => {
                std::slice::from_ref(value)
            }
        };
        if values
            .iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
        {
            Ok(())
        } else {
            Err("material values must be finite and between 0 and 1".to_string())
        }
    }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneNodeSummary {
    pub id: String,
    pub parent: Option<String>,
    pub label: String,
    pub kind: String,
    pub visible: bool,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneTransform {
    pub translation: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneMaterial {
    pub color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSceneNode {
    pub id: String,
    pub transform: SceneTransform,
    pub material: Option<SceneMaterial>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneProjection {
    pub revision: u64,
    pub selected_node_id: Option<String>,
    pub nodes: Vec<SceneNodeSummary>,
    pub selected: Option<SelectedSceneNode>,
}

impl Default for SceneProjection {
    fn default() -> Self {
        Self {
            revision: 0,
            selected_node_id: None,
            nodes: Vec::new(),
            selected: None,
        }
    }
}

/// Managed state shared by Tauri commands and the event-loop thread.  Both
/// mutexes contain only owned strings/DTOs, so they are safe to place in
/// `tauri::State`; no `SceneNode3d` or other Kiss3d handle is stored here.
#[derive(Default)]
pub struct SceneProjectionStore {
    projection: Mutex<SceneProjection>,
    pending_selection: Mutex<Option<String>>,
    pending_commands: Mutex<VecDeque<SceneCommand>>,
}

impl SceneProjectionStore {
    pub fn projection(&self) -> SceneProjection {
        self.projection.lock().unwrap().clone()
    }

    pub fn publish(&self, mut projection: SceneProjection) {
        let mut current = self.projection.lock().unwrap();
        projection.revision = current.revision;
        if *current == projection {
            return;
        }
        projection.revision = current.revision.saturating_add(1);
        *current = projection;
    }

    pub fn request_selection(&self, node_id: String) {
        *self.pending_selection.lock().unwrap() = Some(node_id);
    }

    pub fn take_selection(&self) -> Option<String> {
        self.pending_selection.lock().unwrap().take()
    }

    pub fn request_command(&self, command: SceneCommand) -> Result<(), String> {
        command.validate()?;
        self.pending_commands.lock().unwrap().push_back(command);
        Ok(())
    }

    pub fn take_commands(&self) -> Vec<SceneCommand> {
        self.pending_commands.lock().unwrap().drain(..).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_replaces_pending_selection_and_only_revises_changed_projection() {
        let store = SceneProjectionStore::default();
        store.request_selection("cube".to_string());
        store.request_selection("key-light".to_string());
        assert_eq!(store.take_selection().as_deref(), Some("key-light"));
        assert_eq!(store.take_selection(), None);

        let mut projection = SceneProjection {
            selected_node_id: Some("cube".to_string()),
            ..SceneProjection::default()
        };
        store.publish(projection.clone());
        let first = store.projection();
        store.publish(projection.clone());
        assert_eq!(store.projection().revision, first.revision);

        projection.selected_node_id = Some("key-light".to_string());
        store.publish(projection);
        assert!(store.projection().revision > first.revision);
    }

    #[test]
    fn store_validates_and_preserves_scene_command_order() {
        let store = SceneProjectionStore::default();
        let metallic = SceneCommand::SetMetallic {
            node_id: "cube".to_string(),
            value: 0.75,
        };
        let roughness = SceneCommand::SetRoughness {
            node_id: "cube".to_string(),
            value: 0.25,
        };
        store.request_command(metallic.clone()).unwrap();
        store.request_command(roughness.clone()).unwrap();
        assert_eq!(store.take_commands(), vec![metallic, roughness]);
        assert!(store.take_commands().is_empty());

        assert!(store
            .request_command(SceneCommand::SetMetallic {
                node_id: "cube".to_string(),
                value: f32::NAN,
            })
            .is_err());
        assert!(store
            .request_command(SceneCommand::SetBaseColor {
                node_id: "cube".to_string(),
                color: [1.0, 0.0, 2.0, 1.0],
            })
            .is_err());
    }

    #[test]
    fn scene_command_deserializes_the_typescript_wire_shape() {
        let command: SceneCommand = serde_json::from_str(
            r#"{"type":"setBaseColor","nodeId":"cube","color":[0.1,0.2,0.3,1.0]}"#,
        )
        .unwrap();
        assert_eq!(
            command,
            SceneCommand::SetBaseColor {
                node_id: "cube".to_string(),
                color: [0.1, 0.2, 0.3, 1.0],
            }
        );
    }
}
