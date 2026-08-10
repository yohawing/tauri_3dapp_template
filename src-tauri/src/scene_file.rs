use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::camera::OrbitCamera;
use crate::protocol::CameraState;
use crate::scene::{
    ResolvedAssetPath, Scene, SceneAsset, SceneCamera, SceneInstance, SceneTransform,
};
use crate::scene_projection::SceneProjectionStore;
use crate::{timeline, NATIVE_RENDERER};

#[derive(Clone)]
struct OpenSceneDocument {
    document: Scene,
    path: Option<PathBuf>,
}

#[derive(Default)]
struct SceneFileInner {
    current: Option<OpenSceneDocument>,
    revision: u64,
}

#[derive(Default)]
pub struct SceneFileState {
    inner: Mutex<SceneFileInner>,
}

/// Result of the narrow persistent visibility mutation. Built-in nodes,
/// bones, and IDs that are not present in the open document intentionally
/// return `NotPersistent` so callers can keep those edits renderer-only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SceneVisibilityMutation {
    Updated { previous: bool },
    NotPersistent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneFileStatus {
    pub revision: u64,
    pub path: Option<String>,
    pub display_name: String,
    pub has_document: bool,
    pub can_save: bool,
}

impl SceneFileState {
    pub fn set_document(&self, document: Scene, path: Option<PathBuf>) -> SceneFileStatus {
        let mut inner = self.inner.lock().unwrap();
        inner.current = Some(OpenSceneDocument { document, path });
        inner.revision = inner.revision.saturating_add(1);
        status_from_inner(&inner)
    }

    pub fn status(&self) -> SceneFileStatus {
        status_from_inner(&self.inner.lock().unwrap())
    }

    /// Update the visibility of one existing document-backed runtime
    /// instance. No new IDs are accepted and transient renderer nodes are not
    /// represented by this state. A successful update bumps the document
    /// revision exactly once.
    #[allow(dead_code)]
    pub(crate) fn set_instance_visibility(
        &self,
        instance_id: &str,
        visible: bool,
    ) -> SceneVisibilityMutation {
        let mut inner = self.inner.lock().unwrap();
        set_instance_visibility_locked(&mut inner, instance_id, visible)
    }

    /// Apply a document visibility update and renderer mutation while holding
    /// the document lock. This keeps rollback atomic with respect to Save and
    /// other SceneFileState callers: a renderer rejection restores both the
    /// previous value and the revision before returning the error.
    pub(crate) fn transact_instance_visibility<F>(
        &self,
        instance_id: &str,
        visible: bool,
        apply_renderer: F,
    ) -> Result<SceneVisibilityMutation, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut inner = self.inner.lock().unwrap();
        let mutation = set_instance_visibility_locked(&mut inner, instance_id, visible);
        let SceneVisibilityMutation::Updated { previous } = mutation else {
            return Ok(mutation);
        };

        if let Err(error) = apply_renderer() {
            let current = inner
                .current
                .as_mut()
                .and_then(|document| {
                    document
                        .document
                        .instances
                        .iter_mut()
                        .find(|instance| instance.id == instance_id)
                })
                .ok_or_else(|| {
                    format!(
                        "Scene instance '{instance_id}' disappeared while rolling back visibility"
                    )
                })?;
            current.visible = previous;
            inner.revision = inner.revision.saturating_sub(1);
            return Err(error);
        }

        Ok(SceneVisibilityMutation::Updated { previous })
    }

    fn document_snapshot(&self) -> Option<(Scene, Option<PathBuf>)> {
        self.inner
            .lock()
            .unwrap()
            .current
            .as_ref()
            .map(|current| (current.document.clone(), current.path.clone()))
    }

    pub fn save(
        &self,
        target: Option<PathBuf>,
        camera: CameraState,
    ) -> Result<SceneFileStatus, String> {
        let mut inner = self.inner.lock().unwrap();
        let current = inner.current.as_ref().ok_or_else(|| {
            "the built-in demo is not a Scene document; use File > New first".to_string()
        })?;
        let destination = target
            .or_else(|| current.path.clone())
            .ok_or_else(|| "Scene has no file path; use Save As".to_string())?;

        let mut document = current
            .document
            .rebased_for_save(current.path.as_deref(), &destination)
            .map_err(|error| error.to_string())?;
        document.camera = Some(SceneCamera {
            target: camera.target.map(f64::from),
            yaw: f64::from(camera.yaw),
            pitch: f64::from(camera.pitch),
            distance: f64::from(camera.distance),
        });
        document
            .save(&destination)
            .map_err(|error| error.to_string())?;

        inner.current = Some(OpenSceneDocument {
            document,
            path: Some(destination),
        });
        inner.revision = inner.revision.saturating_add(1);
        Ok(status_from_inner(&inner))
    }
}

fn set_instance_visibility_locked(
    inner: &mut SceneFileInner,
    instance_id: &str,
    visible: bool,
) -> SceneVisibilityMutation {
    let Some(instance) = inner.current.as_mut().and_then(|current| {
        current
            .document
            .instances
            .iter_mut()
            .find(|instance| instance.id == instance_id)
    }) else {
        return SceneVisibilityMutation::NotPersistent;
    };

    let previous = instance.visible;
    instance.visible = visible;
    inner.revision = inner.revision.saturating_add(1);
    SceneVisibilityMutation::Updated { previous }
}

#[tauri::command]
pub(crate) fn get_scene_file_status(state: tauri::State<SceneFileState>) -> SceneFileStatus {
    state.status()
}

#[tauri::command]
pub(crate) fn save_scene_file(
    state: tauri::State<SceneFileState>,
    camera: tauri::State<Mutex<OrbitCamera>>,
    path: Option<String>,
) -> Result<SceneFileStatus, String> {
    state.save(path.map(PathBuf::from), camera.lock().unwrap().state())
}

#[tauri::command]
pub(crate) async fn new_scene_file(app: AppHandle) -> Result<SceneFileStatus, String> {
    replace_scene_on_main_thread(
        app,
        Scene::empty("Untitled"),
        None,
        Vec::new(),
        timeline::TimelineProjection::default(),
        OrbitCamera::default().state(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn open_scene_file(
    app: AppHandle,
    path: String,
) -> Result<SceneFileStatus, String> {
    let path = PathBuf::from(path);
    let preparation_path = path.clone();
    let (document, resolved_assets, timeline_projection, camera) =
        tauri::async_runtime::spawn_blocking(move || {
            let document = Scene::load(&preparation_path).map_err(|error| {
                format!(
                    "Scene '{}' failed to load: {error}",
                    preparation_path.display()
                )
            })?;
            let resolved_assets = document
                .resolve_asset_paths(&preparation_path)
                .map_err(|error| error.to_string())?;
            let timeline_projection = timeline::load_scene_timeline(&document, &resolved_assets)?;
            let camera = scene_camera_state(&document)?;
            Ok::<_, String>((document, resolved_assets, timeline_projection, camera))
        })
        .await
        .map_err(|error| format!("Scene preparation task failed: {error}"))??;

    replace_scene_on_main_thread(
        app,
        document,
        Some(path),
        resolved_assets,
        timeline_projection,
        camera,
    )
    .await
}

#[tauri::command]
pub(crate) async fn import_scene_asset(
    app: AppHandle,
    path: String,
) -> Result<SceneFileStatus, String> {
    let asset_path = PathBuf::from(path);
    let current = app.state::<SceneFileState>().document_snapshot();
    let camera = app.state::<Mutex<OrbitCamera>>().lock().unwrap().state();
    let (document, scene_path, resolved_assets, timeline_projection) =
        tauri::async_runtime::spawn_blocking(move || {
            let (document, scene_path) = append_imported_asset(current, &asset_path)?;
            let resolution_base = scene_path.clone().unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join("untitled.scene.json")
            });
            let resolved_assets = document
                .resolve_asset_paths(&resolution_base)
                .map_err(|error| error.to_string())?;
            let timeline_projection = timeline::load_scene_timeline(&document, &resolved_assets)?;
            Ok::<_, String>((document, scene_path, resolved_assets, timeline_projection))
        })
        .await
        .map_err(|error| format!("Asset import preparation task failed: {error}"))??;

    replace_scene_on_main_thread(
        app,
        document,
        scene_path,
        resolved_assets,
        timeline_projection,
        camera,
    )
    .await
}

async fn replace_scene_on_main_thread(
    app: AppHandle,
    document: Scene,
    path: Option<PathBuf>,
    resolved_assets: Vec<ResolvedAssetPath>,
    timeline_projection: timeline::TimelineProjection,
    camera: CameraState,
) -> Result<SceneFileStatus, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let main_handle = app.clone();
    app.run_on_main_thread(move || {
        let result = NATIVE_RENDERER.with(|slot| {
            let mut renderer_slot = slot.borrow_mut();
            let renderer = renderer_slot
                .as_mut()
                .ok_or_else(|| "native renderer is not initialized".to_string())?;
            renderer
                .replace_with_scene(&document, &resolved_assets, timeline_projection.clips.len())
                .map_err(|error| error.to_string())?;

            *main_handle.state::<Mutex<OrbitCamera>>().lock().unwrap() = {
                let mut next = OrbitCamera::default();
                next.set_state(camera);
                next
            };
            main_handle
                .state::<timeline::TimelineProjectionStore>()
                .replace(timeline_projection);
            main_handle
                .state::<SceneProjectionStore>()
                .replace_scene(renderer.scene_projection(Some(renderer.default_node_id())));
            Ok(main_handle
                .state::<SceneFileState>()
                .set_document(document, path))
        });
        let _ = sender.send(result);
    })
    .map_err(|error| format!("failed to schedule Scene replacement: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|error| format!("Scene replacement result channel closed: {error}"))?
    })
    .await
    .map_err(|error| format!("Scene replacement wait failed: {error}"))?
}

fn append_imported_asset(
    current: Option<(Scene, Option<PathBuf>)>,
    asset_path: &Path,
) -> Result<(Scene, Option<PathBuf>), String> {
    let canonical_asset = asset_path.canonicalize().map_err(|error| {
        format!(
            "Asset '{}' failed to resolve: {error}",
            asset_path.display()
        )
    })?;
    let stored_asset_path = user_facing_absolute_path(canonical_asset.clone());
    let kind = match canonical_asset
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("gltf" | "glb") => "gltf",
        Some("fbx") => "fbx",
        _ => {
            return Err(format!(
                "Asset '{}' has an unsupported extension; expected .gltf, .glb, or .fbx",
                asset_path.display()
            ));
        }
    };
    let (mut document, scene_path) = current.unwrap_or_else(|| (Scene::empty("Untitled"), None));
    let stem = canonical_asset
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("asset");
    let base_id = sanitize_id(stem);
    let asset_id = unique_id(
        &base_id,
        document.assets.iter().map(|asset| asset.id.as_str()),
    );
    let instance_id = unique_id(
        &format!("{asset_id}-1"),
        document
            .instances
            .iter()
            .map(|instance| instance.id.as_str()),
    );
    document.assets.push(SceneAsset {
        id: asset_id.clone(),
        kind: kind.to_string(),
        path: stored_asset_path.to_string_lossy().into_owned(),
    });
    document.instances.push(SceneInstance {
        id: instance_id,
        asset: asset_id,
        transform: SceneTransform {
            translation: [0.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
        },
        visible: true,
    });
    document
        .validate()
        .map_err(|error| crate::scene::SceneError::Validation(error).to_string())?;
    Ok((document, scene_path))
}

fn sanitize_id(stem: &str) -> String {
    let id = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if id.is_empty() {
        "asset".to_string()
    } else {
        id
    }
}

fn user_facing_absolute_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(drive_path) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(drive_path);
        }
    }
    path
}

fn unique_id<'a>(base: &str, existing: impl Iterator<Item = &'a str>) -> String {
    let existing = existing.collect::<std::collections::HashSet<_>>();
    if !existing.contains(base) {
        return base.to_string();
    }
    (2..)
        .map(|suffix| format!("{base}-{suffix}"))
        .find(|candidate| !existing.contains(candidate.as_str()))
        .expect("unbounded suffix search finds an ID")
}

pub(crate) fn scene_camera_state(document: &Scene) -> Result<CameraState, String> {
    let Some(camera) = document.camera.as_ref() else {
        return Ok(OrbitCamera::default().state());
    };

    let cast = |value: f64, field: &str| {
        let value = value as f32;
        if value.is_finite() {
            Ok(value)
        } else {
            Err(format!("Scene camera {field} overflows f32"))
        }
    };

    let state = CameraState {
        target: [
            cast(camera.target[0], "target[0]")?,
            cast(camera.target[1], "target[1]")?,
            cast(camera.target[2], "target[2]")?,
        ],
        yaw: cast(camera.yaw, "yaw")?,
        pitch: cast(camera.pitch, "pitch")?,
        distance: cast(camera.distance, "distance")?,
    };
    if state.distance <= 0.0 {
        return Err(
            "Scene camera distance must remain greater than zero after f32 conversion".into(),
        );
    }
    Ok(state)
}

fn status_from_inner(inner: &SceneFileInner) -> SceneFileStatus {
    let path = inner
        .current
        .as_ref()
        .and_then(|current| current.path.as_ref());
    SceneFileStatus {
        revision: inner.revision,
        path: path.map(|value| value.to_string_lossy().into_owned()),
        display_name: path
            .and_then(|value| value.file_name())
            .map(|value| value.to_string_lossy().into_owned())
            .or_else(|| {
                inner
                    .current
                    .as_ref()
                    .and_then(|current| current.document.name.clone())
            })
            .unwrap_or_else(|| "Built-in Scene".to_string()),
        has_document: inner.current.is_some(),
        can_save: path.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::SceneAsset;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tauri3d-scene-file-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn camera_state() -> CameraState {
        CameraState {
            target: [1.0, 2.0, 3.0],
            yaw: -0.8,
            pitch: 0.4,
            distance: 3.5,
        }
    }

    fn document(camera: SceneCamera) -> Scene {
        Scene {
            version: 1,
            name: None,
            assets: Vec::new(),
            instances: Vec::new(),
            camera: Some(camera),
        }
    }

    fn document_with_instances() -> Scene {
        Scene {
            version: 1,
            name: Some("Visibility".into()),
            assets: vec![SceneAsset {
                id: "hero".into(),
                kind: "gltf".into(),
                path: "hero.glb".into(),
            }],
            instances: vec![
                SceneInstance {
                    id: "hero-1".into(),
                    asset: "hero".into(),
                    transform: SceneTransform {
                        translation: [0.0; 3],
                        rotation: [0.0, 0.0, 0.0, 1.0],
                        scale: [1.0; 3],
                    },
                    visible: true,
                },
                SceneInstance {
                    id: "hero-2".into(),
                    asset: "hero".into(),
                    transform: SceneTransform {
                        translation: [1.0, 0.0, 0.0],
                        rotation: [0.0, 0.0, 0.0, 1.0],
                        scale: [1.0; 3],
                    },
                    visible: true,
                },
            ],
            camera: Some(SceneCamera {
                target: [3.0, 2.0, 1.0],
                yaw: -0.4,
                pitch: 0.2,
                distance: 6.0,
            }),
        }
    }

    #[test]
    fn scene_camera_state_converts_and_preserves_values() {
        let state = scene_camera_state(&document(SceneCamera {
            target: [1.0, 2.0, 3.0],
            yaw: -0.8,
            pitch: 0.4,
            distance: 3.5,
        }))
        .unwrap();
        assert_eq!(state.target, [1.0, 2.0, 3.0]);
        assert_eq!(state.yaw, -0.8);
        assert_eq!(state.pitch, 0.4);
        assert_eq!(state.distance, 3.5);
    }

    #[test]
    fn scene_camera_state_rejects_f32_overflow() {
        let error = scene_camera_state(&document(SceneCamera {
            target: [f64::MAX, 0.0, 0.0],
            yaw: 0.0,
            pitch: 0.0,
            distance: 1.0,
        }))
        .unwrap_err();
        assert!(error.contains("target[0]"));
        assert!(error.contains("overflows f32"));
    }

    #[test]
    fn status_distinguishes_builtin_untitled_and_opened_documents() {
        let state = SceneFileState::default();
        let built_in = state.status();
        assert!(!built_in.has_document);
        assert!(!built_in.can_save);

        let untitled = state.set_document(Scene::empty("Untitled"), None);
        assert!(untitled.has_document);
        assert!(!untitled.can_save);
        assert_eq!(untitled.display_name, "Untitled");

        let opened = state.set_document(
            Scene::empty("Ignored once a path exists"),
            Some(PathBuf::from("example.scene.json")),
        );
        assert!(opened.can_save);
        assert_eq!(opened.display_name, "example.scene.json");
        assert!(opened.revision > untitled.revision);
    }

    #[test]
    fn normal_save_uses_current_path_and_persists_camera() {
        let root = temp_path("normal-save");
        fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("opened.scene.json");
        let state = SceneFileState::default();
        let opened = state.set_document(Scene::empty("Opened"), Some(path.clone()));

        let saved = state
            .save(None, camera_state())
            .expect("save current scene");

        assert_eq!(saved.path.as_deref(), Some(path.to_string_lossy().as_ref()));
        assert_eq!(saved.revision, opened.revision + 1);
        let reloaded = Scene::load(&path).expect("reload saved scene");
        assert_eq!(reloaded.camera, Some(document_camera()));
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn failed_save_preserves_document_path_and_revision() {
        let root = temp_path("failed-save");
        let path = root.join("missing-parent").join("opened.scene.json");
        let state = SceneFileState::default();
        let opened = state.set_document(Scene::empty("Opened"), Some(path.clone()));

        state
            .save(None, camera_state())
            .expect_err("save without parent must fail");

        let after_failure = state.status();
        assert_eq!(after_failure.path, opened.path);
        assert_eq!(after_failure.revision, opened.revision);
        fs::create_dir_all(path.parent().unwrap()).expect("create missing parent");
        state
            .save(None, camera_state())
            .expect("retry retains the original document");
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn save_as_rebases_relative_asset_through_file_state() {
        let root = temp_path("save-as-rebase");
        let source = root.join("source").join("opened.scene.json");
        let target = root.join("saved").join("copy.scene.json");
        let asset = root.join("source").join("assets").join("model.glb");
        fs::create_dir_all(target.parent().unwrap()).expect("create target directory");
        fs::create_dir_all(asset.parent().unwrap()).expect("create asset directory");
        fs::write(&asset, b"fixture").expect("create asset fixture");
        let scene = Scene {
            version: 1,
            name: Some("Portable".into()),
            assets: vec![SceneAsset {
                id: "asset".into(),
                kind: "gltf".into(),
                path: "assets/model.glb".into(),
            }],
            instances: Vec::new(),
            camera: None,
        };
        let state = SceneFileState::default();
        state.set_document(scene, Some(source));

        state
            .save(Some(target.clone()), camera_state())
            .expect("save as scene");

        let reloaded = Scene::load(&target).expect("reload saved-as scene");
        assert_eq!(
            PathBuf::from(&reloaded.assets[0].path),
            PathBuf::from("..").join("source/assets/model.glb")
        );
        let resolved = reloaded
            .resolve_asset_paths(&target)
            .expect("resolve rebased asset")[0]
            .resolved_path
            .canonicalize()
            .expect("canonicalize resolved asset");
        assert_eq!(resolved, asset.canonicalize().expect("canonicalize asset"));
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn imported_asset_creates_unique_asset_and_instance_ids() {
        let root = temp_path("import-ids");
        fs::create_dir_all(&root).expect("create temp directory");
        let scene_path = root.join("opened.scene.json");
        let asset_path = root.join("Hero Model.fbx");
        fs::write(&asset_path, b"fixture").expect("create asset fixture");
        let mut scene = Scene::empty("Opened");
        scene.assets.push(SceneAsset {
            id: "hero-model".into(),
            kind: "fbx".into(),
            path: "existing.fbx".into(),
        });
        scene.instances.push(SceneInstance {
            id: "hero-model-2-1".into(),
            asset: "hero-model".into(),
            transform: SceneTransform {
                translation: [0.0; 3],
                rotation: [0.0, 0.0, 0.0, 1.0],
                scale: [1.0; 3],
            },
            visible: true,
        });

        let (imported, retained_path) =
            append_imported_asset(Some((scene, Some(scene_path.clone()))), &asset_path)
                .expect("append imported FBX");

        assert_eq!(retained_path, Some(scene_path));
        assert_eq!(imported.assets.last().unwrap().id, "hero-model-2");
        assert_eq!(
            PathBuf::from(&imported.assets.last().unwrap().path),
            asset_path
        );
        assert_eq!(imported.instances.last().unwrap().id, "hero-model-2-1-2");
        assert_eq!(imported.instances.last().unwrap().asset, "hero-model-2");
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn rejected_import_does_not_mutate_file_state() {
        let root = temp_path("import-reject");
        fs::create_dir_all(&root).expect("create temp directory");
        let asset_path = root.join("notes.txt");
        fs::write(&asset_path, b"not an asset").expect("create rejected fixture");
        let state = SceneFileState::default();
        let before = state.set_document(Scene::empty("Current"), None);
        let snapshot = state.document_snapshot();

        let error = append_imported_asset(snapshot, &asset_path).unwrap_err();

        assert!(error.contains(asset_path.to_string_lossy().as_ref()));
        assert!(error.contains("unsupported extension"));
        assert_eq!(state.status().revision, before.revision);
        assert_eq!(state.status().display_name, "Current");
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn instance_visibility_mutation_updates_only_existing_instance_and_revision() {
        let state = SceneFileState::default();
        let opened = state.set_document(document_with_instances(), None);

        assert_eq!(
            state.set_instance_visibility("hero-1", false),
            SceneVisibilityMutation::Updated { previous: true }
        );
        assert_eq!(state.status().revision, opened.revision + 1);
        let (document, _) = state.document_snapshot().expect("document remains open");
        assert!(!document.instances[0].visible);
        assert!(document.instances[1].visible);
        assert_eq!(document.camera.as_ref().unwrap().target, [3.0, 2.0, 1.0]);

        assert_eq!(
            state.set_instance_visibility("does-not-exist", false),
            SceneVisibilityMutation::NotPersistent
        );
        assert_eq!(state.status().revision, opened.revision + 1);
        let (after_missing, _) = state.document_snapshot().expect("document remains open");
        assert_eq!(after_missing, document);
    }

    #[test]
    fn instance_visibility_save_reload_preserves_false_without_other_document_changes() {
        let root = temp_path("visibility-round-trip");
        fs::create_dir_all(&root).expect("create temp directory");
        let asset = root.join("hero.glb");
        fs::write(&asset, b"fixture").expect("create asset fixture");
        let path = root.join("visibility.scene.json");
        let mut source = document_with_instances();
        source.assets[0].path = asset.to_string_lossy().into_owned();
        let state = SceneFileState::default();
        state.set_document(source.clone(), Some(path.clone()));
        assert_eq!(
            state.set_instance_visibility("hero-1", false),
            SceneVisibilityMutation::Updated { previous: true }
        );
        let before_save = state.document_snapshot().expect("document remains open").0;

        state
            .save(None, camera_state())
            .expect("save changed visibility");
        let reloaded = Scene::load(&path).expect("reload saved scene");
        assert!(!reloaded.instances[0].visible);
        assert!(reloaded.instances[1].visible);
        assert_eq!(reloaded.assets, before_save.assets);
        assert_eq!(reloaded.camera, Some(document_camera()));
        assert_eq!(
            reloaded.instances[0].transform,
            before_save.instances[0].transform
        );
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn rejected_renderer_visibility_rolls_back_value_and_revision() {
        let state = SceneFileState::default();
        let opened = state.set_document(document_with_instances(), None);
        let error = state
            .transact_instance_visibility("hero-1", false, || Err("renderer rejected".into()))
            .expect_err("renderer rejection must fail transaction");
        assert_eq!(error, "renderer rejected");
        assert_eq!(state.status().revision, opened.revision);
        let (document, _) = state.document_snapshot().expect("document remains open");
        assert!(document.instances[0].visible);
        assert!(document.instances[1].visible);
    }

    #[test]
    fn missing_instance_never_invokes_renderer_transaction() {
        let state = SceneFileState::default();
        state.set_document(document_with_instances(), None);
        let mut renderer_called = false;
        let outcome = state
            .transact_instance_visibility("missing", false, || {
                renderer_called = true;
                Ok(())
            })
            .expect("missing instance is a non-persistent no-op");
        assert_eq!(outcome, SceneVisibilityMutation::NotPersistent);
        assert!(!renderer_called);
    }

    fn document_camera() -> SceneCamera {
        let camera = camera_state();
        SceneCamera {
            target: camera.target.map(f64::from),
            yaw: f64::from(camera.yaw),
            pitch: f64::from(camera.pitch),
            distance: f64::from(camera.distance),
        }
    }
}
