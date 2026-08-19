use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::camera::{validate_camera_state, OrbitCamera};
use crate::protocol::CameraState;
use crate::scene::{
    diagnostic_path, diagnostic_text, ResolvedAssetPath, Scene, SceneAsset, SceneCamera,
    SceneInstance, SceneTransform,
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
    replacement_generation: u64,
    claimed_replacement_generation: u64,
    replacement_in_progress: Option<u64>,
    save_generation: u64,
    save_in_progress: Option<u64>,
}

#[derive(Default)]
pub struct SceneFileState {
    inner: Mutex<SceneFileInner>,
}

/// Monotonic identity for one New/Open/Import request. The token is assigned
/// before any asynchronous preparation starts; only the most recent token may
/// cross the native replacement commit boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SceneReplacementToken {
    generation: u64,
    revision: u64,
}

/// Releases a replacement reservation if the main-thread callback unwinds
/// before `complete_replacement` runs. Known error paths already release
/// explicitly; this guard covers unexpected panics without leaving the state
/// permanently busy for subsequent New/Open/Import requests.
struct ReplacementReservationGuard<'a> {
    state: &'a SceneFileState,
    token: Option<SceneReplacementToken>,
}

impl ReplacementReservationGuard<'_> {
    fn release(&mut self) {
        if let Some(token) = self.token.take() {
            self.state.release_replacement(token);
        }
    }

    fn disarm(&mut self) {
        self.token = None;
    }
}

impl Drop for ReplacementReservationGuard<'_> {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            // A panic while holding the SceneFileState mutex poisons it. Do
            // not turn an unrelated callback panic into a double-panic abort
            // while attempting best-effort reservation cleanup.
            let state = self.state;
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                state.release_replacement(token);
            }));
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SceneSaveToken {
    generation: u64,
    revision: u64,
}

type SceneImportSnapshot = Option<(Scene, Option<PathBuf>)>;

struct SceneSavePreparation {
    token: SceneSaveToken,
    document: Scene,
    current_path: Option<PathBuf>,
    destination: PathBuf,
}

struct SceneReplacementRequest {
    document: Scene,
    path: Option<PathBuf>,
    resolved_assets: Vec<ResolvedAssetPath>,
    timeline_projection: timeline::TimelineProjection,
    /// New/Open provide the camera loaded from the replacement document.
    /// Import is an additive operation and leaves the latest live camera intact.
    camera: Option<CameraState>,
    token: SceneReplacementToken,
    expected_revision: Option<u64>,
}

const ASSET_DECODE_LOG_ENV: &str = "TAURI3D_LOG_ASSET_DECODE";
const MAX_SCENE_STATUS_PATH_BYTES: usize = 4_096;
const MAX_SCENE_STATUS_DISPLAY_NAME_BYTES: usize = 1_024;

/// Keep the successful SceneFileStatus wire payload within the frontend's
/// bounded path/display-name contract without rewriting the stored path.
pub(crate) fn validate_scene_status_path(path: &Path) -> Result<(), String> {
    let path_text = path.to_string_lossy();
    if path_text.len() > MAX_SCENE_STATUS_PATH_BYTES {
        return Err(format!(
            "Scene path exceeds the {MAX_SCENE_STATUS_PATH_BYTES}-byte status limit"
        ));
    }
    if let Some(file_name) = path.file_name() {
        let display_name = file_name.to_string_lossy();
        if display_name.len() > MAX_SCENE_STATUS_DISPLAY_NAME_BYTES {
            return Err(format!(
                "Scene display name exceeds the {MAX_SCENE_STATUS_DISPLAY_NAME_BYTES}-byte status limit"
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ReplacementAssetSummary {
    gltf_assets: usize,
    fbx_assets: usize,
    instances: usize,
}

struct ReplacementProbe {
    summary: ReplacementAssetSummary,
    queued_at: Instant,
}

/// Result of the narrow persistent visibility mutation. Built-in nodes,
/// bones, and IDs that are not present in the open document intentionally
/// return `NotPersistent` so callers can keep those edits renderer-only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SceneVisibilityMutation {
    Updated { previous: bool },
    NotPersistent,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum SceneTransformMutation {
    Updated { previous: SceneTransform },
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
    pub(crate) fn begin_replacement(&self) -> Result<SceneReplacementToken, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.replacement_in_progress.is_some() {
            return Err("Scene replacement is in progress; New/Open/Import was rejected".into());
        }
        if inner.save_in_progress.is_some() {
            return Err("Scene save is in progress; New/Open/Import was rejected".into());
        }
        inner.replacement_generation = inner.replacement_generation.saturating_add(1);
        Ok(SceneReplacementToken {
            generation: inner.replacement_generation,
            revision: inner.revision,
        })
    }

    /// Capture the exact document revision used by an asynchronous Import
    /// preparation. The token and snapshot are taken under one lock so a
    /// concurrent document mutation cannot be omitted from the revision check.
    pub(crate) fn begin_import(
        &self,
    ) -> Result<(SceneReplacementToken, SceneImportSnapshot), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.replacement_in_progress.is_some() {
            return Err("Scene replacement is in progress; New/Open/Import was rejected".into());
        }
        if inner.save_in_progress.is_some() {
            return Err("Scene save is in progress; New/Open/Import was rejected".into());
        }
        inner.replacement_generation = inner.replacement_generation.saturating_add(1);
        let token = SceneReplacementToken {
            generation: inner.replacement_generation,
            revision: inner.revision,
        };
        let snapshot = inner
            .current
            .as_ref()
            .map(|current| (current.document.clone(), current.path.clone()));
        Ok((token, snapshot))
    }

    pub(crate) fn validate_replacement(
        &self,
        token: SceneReplacementToken,
        expected_revision: Option<u64>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.replacement_generation != token.generation {
            return Err(
                "Scene replacement request is stale; a newer New/Open/Import request superseded it"
                    .to_string(),
            );
        }
        if inner.claimed_replacement_generation == token.generation {
            return Err("Scene replacement request was already committed".to_string());
        }
        if expected_revision.is_some_and(|revision| revision != inner.revision) {
            return Err(
                "Scene changed during asset import preparation; import was rejected".to_string(),
            );
        }
        // Claim at the commit boundary. The caller must invoke this directly
        // before renderer.replace_with_scene; a renderer failure consumes the
        // token and requires a new explicit request rather than a hidden retry.
        inner.claimed_replacement_generation = token.generation;
        inner.replacement_in_progress = Some(token.generation);
        Ok(())
    }

    pub(crate) fn complete_replacement(
        &self,
        token: SceneReplacementToken,
        document: Scene,
        path: Option<PathBuf>,
    ) -> Result<SceneFileStatus, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.replacement_in_progress != Some(token.generation) {
            return Err("Scene replacement reservation is not owned by this request".to_string());
        }
        inner.current = Some(OpenSceneDocument { document, path });
        inner.revision = inner.revision.saturating_add(1);
        inner.replacement_in_progress = None;
        Ok(status_from_inner(&inner))
    }

    pub(crate) fn release_replacement(&self, token: SceneReplacementToken) {
        let mut inner = self.inner.lock().unwrap();
        if inner.replacement_in_progress == Some(token.generation) {
            inner.replacement_in_progress = None;
        }
    }

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
        if inner.replacement_in_progress.is_some() || inner.save_in_progress.is_some() {
            return SceneVisibilityMutation::NotPersistent;
        }
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
        if let Some(error) = mutation_busy_error(&inner, "visibility") {
            return Err(error);
        }
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

    /// Keep a document-backed instance transform and its live renderer node
    /// in one transaction so Save never observes a value rejected by the
    /// native scene graph.
    pub(crate) fn transact_instance_transform<F>(
        &self,
        instance_id: &str,
        transform: SceneTransform,
        apply_renderer: F,
    ) -> Result<SceneTransformMutation, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut inner = self.inner.lock().unwrap();
        if let Some(error) = mutation_busy_error(&inner, "transform") {
            return Err(error);
        }
        let mutation = set_instance_transform_locked(&mut inner, instance_id, transform);
        let SceneTransformMutation::Updated { previous } = mutation else {
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
                        "Scene instance '{instance_id}' disappeared while rolling back transform"
                    )
                })?;
            current.transform = previous.clone();
            inner.revision = inner.revision.saturating_sub(1);
            return Err(error);
        }

        Ok(SceneTransformMutation::Updated { previous })
    }

    #[cfg(test)]
    fn document_snapshot(&self) -> Option<(Scene, Option<PathBuf>)> {
        self.inner
            .lock()
            .unwrap()
            .current
            .as_ref()
            .map(|current| (current.document.clone(), current.path.clone()))
    }

    fn begin_save(&self, target: Option<PathBuf>) -> Result<SceneSavePreparation, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.replacement_in_progress.is_some() {
            return Err("Scene replacement is in progress; save was rejected".to_string());
        }
        if inner.save_in_progress.is_some() {
            return Err("Scene save is in progress; save was rejected".to_string());
        }
        let current = inner.current.as_ref().ok_or_else(|| {
            "the built-in demo is not a Scene document; use File > New first".to_string()
        })?;
        let current_path = current.path.clone();
        let document = current.document.clone();
        let destination = target
            .or(current_path.clone())
            .ok_or_else(|| "Scene has no file path; use Save As".to_string())?;
        inner.save_generation = inner.save_generation.saturating_add(1);
        let token = SceneSaveToken {
            generation: inner.save_generation,
            revision: inner.revision,
        };
        inner.save_in_progress = Some(token.generation);
        Ok(SceneSavePreparation {
            token,
            document,
            current_path,
            destination,
        })
    }

    fn complete_save(
        &self,
        token: SceneSaveToken,
        document: Scene,
        destination: PathBuf,
    ) -> Result<SceneFileStatus, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.save_in_progress != Some(token.generation) {
            return Err("Scene save reservation is not owned by this request".to_string());
        }
        if inner.revision != token.revision {
            inner.save_in_progress = None;
            return Err("Scene changed while save was in progress; save was rejected".to_string());
        }
        inner.current = Some(OpenSceneDocument {
            document,
            path: Some(destination),
        });
        inner.revision = inner.revision.saturating_add(1);
        inner.save_in_progress = None;
        Ok(status_from_inner(&inner))
    }

    fn release_save(&self, token: SceneSaveToken) {
        let mut inner = self.inner.lock().unwrap();
        if inner.save_in_progress == Some(token.generation) {
            inner.save_in_progress = None;
        }
    }

    pub fn save(
        &self,
        target: Option<PathBuf>,
        camera: CameraState,
    ) -> Result<SceneFileStatus, String> {
        let preparation = self.begin_save(target)?;
        let mut document = preparation.document;
        let result = (|| {
            let write_destination = resolve_save_target(&preparation.destination)?;
            document = document
                .rebased_for_save(
                    preparation.current_path.as_deref(),
                    &preparation.destination,
                )
                .map_err(|error| error.to_string())?;
            document.camera = Some(SceneCamera {
                target: camera.target.map(f64::from),
                yaw: f64::from(camera.yaw),
                pitch: f64::from(camera.pitch),
                distance: f64::from(camera.distance),
            });
            document
                .save(&write_destination)
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            self.release_save(preparation.token);
            return Err(error);
        }
        self.complete_save(preparation.token, document, preparation.destination)
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

fn mutation_busy_error(inner: &SceneFileInner, operation: &str) -> Option<String> {
    if inner.replacement_in_progress.is_some() {
        Some(format!(
            "Scene replacement is in progress; {operation} edit was rejected"
        ))
    } else if inner.save_in_progress.is_some() {
        Some(format!(
            "Scene save is in progress; {operation} edit was rejected"
        ))
    } else {
        None
    }
}

fn set_instance_transform_locked(
    inner: &mut SceneFileInner,
    instance_id: &str,
    transform: SceneTransform,
) -> SceneTransformMutation {
    let Some(instance) = inner.current.as_mut().and_then(|current| {
        current
            .document
            .instances
            .iter_mut()
            .find(|instance| instance.id == instance_id)
    }) else {
        return SceneTransformMutation::NotPersistent;
    };

    let previous = std::mem::replace(&mut instance.transform, transform);
    inner.revision = inner.revision.saturating_add(1);
    SceneTransformMutation::Updated { previous }
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
    if let Some(path) = path.as_deref() {
        validate_scene_status_path(Path::new(path))?;
    }
    let camera = camera.lock().unwrap().state();
    state.save(path.map(PathBuf::from), camera)
}

#[tauri::command]
pub(crate) async fn new_scene_file(app: AppHandle) -> Result<SceneFileStatus, String> {
    let token = app.state::<SceneFileState>().begin_replacement()?;
    replace_scene_on_main_thread(
        app,
        SceneReplacementRequest {
            document: Scene::empty("Untitled"),
            path: None,
            resolved_assets: Vec::new(),
            timeline_projection: timeline::TimelineProjection::default(),
            camera: Some(OrbitCamera::default().state()),
            token,
            expected_revision: None,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn open_scene_file(
    app: AppHandle,
    path: String,
) -> Result<SceneFileStatus, String> {
    validate_scene_status_path(Path::new(&path))?;
    let token = app.state::<SceneFileState>().begin_replacement()?;
    let path = PathBuf::from(path);
    let preparation_path = path.clone();
    let (document, resolved_assets, timeline_projection, camera) =
        tauri::async_runtime::spawn_blocking(move || {
            let document = Scene::load(&preparation_path).map_err(|error| {
                format!(
                    "Scene '{}' failed to load: {}",
                    diagnostic_path(&preparation_path),
                    diagnostic_text(&error.to_string())
                )
            })?;
            let resolved_assets = document
                .resolve_asset_paths(&preparation_path)
                .map_err(|error| error.to_string())?;
            validate_resolved_assets(&document, &resolved_assets)?;
            let timeline_projection = timeline::load_scene_timeline(&document, &resolved_assets)?;
            let camera = scene_camera_state(&document)?;
            Ok::<_, String>((document, resolved_assets, timeline_projection, camera))
        })
        .await
        .map_err(|error| format!("Scene preparation task failed: {error}"))??;

    replace_scene_on_main_thread(
        app,
        SceneReplacementRequest {
            document,
            path: Some(path),
            resolved_assets,
            timeline_projection,
            camera: Some(camera),
            token,
            expected_revision: None,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn import_scene_asset(
    app: AppHandle,
    path: String,
) -> Result<SceneFileStatus, String> {
    let (token, current) = app.state::<SceneFileState>().begin_import()?;
    let asset_path = PathBuf::from(path);
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
            validate_resolved_assets(&document, &resolved_assets)?;
            let timeline_projection = timeline::load_scene_timeline(&document, &resolved_assets)?;
            Ok::<_, String>((document, scene_path, resolved_assets, timeline_projection))
        })
        .await
        .map_err(|error| format!("Asset import preparation task failed: {error}"))??;

    replace_scene_on_main_thread(
        app,
        SceneReplacementRequest {
            document,
            path: scene_path,
            resolved_assets,
            timeline_projection,
            camera: None,
            token,
            expected_revision: Some(token.revision),
        },
    )
    .await
}

async fn replace_scene_on_main_thread(
    app: AppHandle,
    request: SceneReplacementRequest,
) -> Result<SceneFileStatus, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let probe = asset_decode_logging_enabled().then(|| ReplacementProbe {
        summary: replacement_asset_summary(&request.document),
        queued_at: Instant::now(),
    });
    let main_handle = app.clone();
    app.run_on_main_thread(move || {
        let callback_started = probe.as_ref().map(|_| Instant::now());
        let mut decode_elapsed = probe.as_ref().map(|_| Duration::ZERO);
        let result = match main_handle
            .state::<SceneFileState>()
            .validate_replacement(request.token, request.expected_revision)
        {
            Err(error) => Err(error),
            Ok(()) => NATIVE_RENDERER.with(|slot| {
                let scene_state = main_handle.state::<SceneFileState>();
                let mut reservation_guard = ReplacementReservationGuard {
                    state: &scene_state,
                    token: Some(request.token),
                };
                let mut renderer_slot = slot.borrow_mut();
                let Some(renderer) = renderer_slot.as_mut() else {
                    reservation_guard.release();
                    return Err("native renderer is not initialized".to_string());
                };
                let decode_started = probe.as_ref().map(|_| Instant::now());
                let replace_result = renderer.replace_with_scene(
                    &request.document,
                    &request.resolved_assets,
                    request.timeline_projection.clips.len(),
                );
                if let Some(started) = decode_started {
                    decode_elapsed = Some(started.elapsed());
                }
                if let Err(error) = replace_result {
                    reservation_guard.release();
                    return Err(error.to_string());
                }

                main_handle
                    .state::<crate::timeline_playback::TimelinePlaybackStore>()
                    .replace_scene();
                let camera_state = main_handle.state::<Mutex<OrbitCamera>>();
                {
                    let mut camera = camera_state.lock().unwrap();
                    let current_camera = camera.state();
                    let mut next = OrbitCamera::default();
                    next.set_state(replacement_camera_state(request.camera, current_camera));
                    *camera = next;
                }
                main_handle
                    .state::<timeline::TimelineProjectionStore>()
                    .replace(request.timeline_projection);
                main_handle
                    .state::<SceneProjectionStore>()
                    .replace_scene(renderer.scene_projection(Some(renderer.default_node_id())));
                let result =
                    scene_state.complete_replacement(request.token, request.document, request.path);
                if result.is_ok() {
                    reservation_guard.disarm();
                }
                result
            }),
        };
        if let (Some(probe), Some(callback_started), Some(decode_elapsed)) =
            (probe.as_ref(), callback_started, decode_elapsed)
        {
            let main_thread_elapsed = callback_started.elapsed();
            let queue_elapsed = callback_started.duration_since(probe.queued_at);
            eprintln!(
                "{}",
                format_asset_decode_log(
                    probe.summary,
                    queue_elapsed,
                    decode_elapsed,
                    main_thread_elapsed,
                    if result.is_ok() { "ok" } else { "error" },
                )
            );
        }
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
            "Asset '{}' failed to resolve: {}",
            diagnostic_path(asset_path),
            diagnostic_text(&error.to_string())
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
                diagnostic_path(asset_path)
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

fn validate_resolved_assets(
    document: &Scene,
    resolved_assets: &[ResolvedAssetPath],
) -> Result<(), String> {
    for resolved in resolved_assets {
        let asset = document
            .assets
            .iter()
            .find(|asset| asset.id == resolved.asset_id)
            .ok_or_else(|| {
                format!(
                    "asset '{}' has no Scene definition",
                    diagnostic_text(&resolved.asset_id)
                )
            })?;
        crate::renderer::validate_runtime_asset_source(&resolved.resolved_path, &asset.kind)
            .map_err(|error| {
                format!(
                    "asset '{}' failed preflight at '{}': {}",
                    diagnostic_text(&asset.id),
                    diagnostic_path(&resolved.resolved_path),
                    diagnostic_text(&error),
                )
            })?;
    }
    Ok(())
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
    validate_camera_state(&state).map_err(|error| format!("Scene camera {error}"))?;
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

/// Follow an existing file symlink before the atomic temp-file replacement.
///
/// The user-facing Scene path remains the alias in `SceneFileState`; only the
/// write target is canonicalized so Save does not replace the symlink itself.
/// The metadata check and subsequent rename are best-effort against a
/// concurrent filesystem replacement (TOCTOU); a later operation can still
/// change the link after this check.
fn resolve_save_target(destination: &Path) -> Result<PathBuf, String> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            destination.canonicalize().map_err(|error| {
                format!(
                    "failed to resolve Scene save symlink '{}': {}",
                    diagnostic_path(destination),
                    diagnostic_text(&error.to_string())
                )
            })
        }
        Ok(_) => Ok(destination.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(destination.to_path_buf()),
        Err(error) => Err(format!(
            "failed to inspect Scene save destination '{}': {}",
            diagnostic_path(destination),
            diagnostic_text(&error.to_string())
        )),
    }
}

fn replacement_camera_state(prepared: Option<CameraState>, current: CameraState) -> CameraState {
    prepared.unwrap_or(current)
}

fn asset_decode_logging_enabled_value(value: Option<&str>) -> bool {
    value.is_some_and(|value| value != "0")
}

fn asset_decode_logging_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        asset_decode_logging_enabled_value(std::env::var(ASSET_DECODE_LOG_ENV).ok().as_deref())
    })
}

fn replacement_asset_summary(document: &Scene) -> ReplacementAssetSummary {
    let mut summary = ReplacementAssetSummary {
        instances: document.instances.len(),
        ..ReplacementAssetSummary::default()
    };
    for asset in &document.assets {
        match asset.kind.as_str() {
            "gltf" => summary.gltf_assets = summary.gltf_assets.saturating_add(1),
            "fbx" => summary.fbx_assets = summary.fbx_assets.saturating_add(1),
            _ => {}
        }
    }
    summary
}

fn format_asset_decode_log(
    summary: ReplacementAssetSummary,
    queue: Duration,
    decode: Duration,
    main_thread: Duration,
    outcome: &str,
) -> String {
    format!(
        "[asset-load] {{\"operation\":\"scene-replace\",\"gltfAssets\":{},\"fbxAssets\":{},\"instances\":{},\"queueMs\":{:.3},\"decodeMs\":{:.3},\"mainThreadMs\":{:.3},\"outcome\":\"{outcome}\"}}",
        summary.gltf_assets,
        summary.fbx_assets,
        summary.instances,
        queue.as_secs_f64() * 1000.0,
        decode.as_secs_f64() * 1000.0,
        main_thread.as_secs_f64() * 1000.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{AssetPathKind, SceneAsset};
    use std::fs;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::Arc;
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

    #[test]
    fn replacement_reservation_guard_releases_after_panic() {
        let state = SceneFileState::default();
        let token = state.begin_replacement().expect("begin replacement");
        state
            .validate_replacement(token, None)
            .expect("claim replacement");

        let result = catch_unwind(AssertUnwindSafe(|| {
            let _guard = ReplacementReservationGuard {
                state: &state,
                token: Some(token),
            };
            panic!("injected replacement callback panic");
        }));
        assert!(result.is_err());

        let next = state
            .begin_replacement()
            .expect("panic must not leave replacement permanently busy");
        state.release_replacement(next);
    }

    fn camera_state() -> CameraState {
        CameraState {
            target: [1.0, 2.0, 3.0],
            yaw: -0.8,
            pitch: 0.4,
            distance: 3.5,
        }
    }

    #[test]
    fn save_target_keeps_new_or_regular_destination() {
        let destination = temp_path("save-target-new").join("scene.json");
        assert_eq!(
            resolve_save_target(&destination).expect("resolve save target"),
            destination
        );
    }

    #[test]
    fn scene_status_path_validation_matches_frontend_utf8_limits() {
        let too_long_path =
            PathBuf::from("p".repeat(MAX_SCENE_STATUS_PATH_BYTES - 8)).join("scene.json");
        let path_error = validate_scene_status_path(&too_long_path).unwrap_err();
        assert!(path_error.contains("path"));

        let too_long_name = PathBuf::from("n".repeat(MAX_SCENE_STATUS_DISPLAY_NAME_BYTES + 1));
        let name_error = validate_scene_status_path(&too_long_name).unwrap_err();
        assert!(name_error.contains("display name"));

        let valid_unicode_name = PathBuf::from("界".repeat(341));
        assert!(validate_scene_status_path(&valid_unicode_name).is_ok());
        let too_long_unicode_name = PathBuf::from("界".repeat(342));
        assert!(validate_scene_status_path(&too_long_unicode_name).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn save_follows_existing_symlink_without_replacing_alias() {
        use std::os::unix::fs::symlink;

        let root = temp_path("save-symlink");
        fs::create_dir_all(&root).expect("create symlink fixture directory");
        let target = root.join("target.scene.json");
        let alias = root.join("alias.scene.json");
        fs::write(&target, b"old scene contents").expect("create target");
        symlink(&target, &alias).expect("create scene symlink");

        let state = SceneFileState::default();
        state.set_document(Scene::empty("Alias"), Some(alias.clone()));
        let status = state
            .save(None, camera_state())
            .expect("save through symlink");

        assert_eq!(status.path.as_deref(), alias.to_str());
        assert!(fs::symlink_metadata(&alias)
            .expect("inspect alias")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(&alias).expect("read alias target"),
            fs::read(&target).expect("read target")
        );
        assert_eq!(
            Scene::load(&target).expect("load target").name.as_deref(),
            Some("Alias")
        );

        fs::remove_file(&alias).expect("remove alias");
        fs::remove_file(&target).expect("remove target");
        fs::remove_dir(&root).expect("remove symlink fixture directory");
    }

    #[test]
    fn asset_decode_logging_is_opt_in() {
        assert!(!asset_decode_logging_enabled_value(None));
        assert!(!asset_decode_logging_enabled_value(Some("0")));
        assert!(asset_decode_logging_enabled_value(Some("1")));
    }

    #[test]
    fn replacement_asset_summary_counts_supported_kinds_without_paths() {
        let mut scene = document_with_instances();
        scene.assets.push(SceneAsset {
            id: "motion".into(),
            kind: "fbx".into(),
            path: r"C:\assets\motion.fbx".into(),
        });
        let summary = replacement_asset_summary(&scene);
        assert_eq!(
            summary,
            ReplacementAssetSummary {
                gltf_assets: 1,
                fbx_assets: 1,
                instances: 2,
            }
        );
    }

    #[test]
    fn asset_decode_log_is_bounded_and_does_not_include_paths() {
        let line = format_asset_decode_log(
            ReplacementAssetSummary {
                gltf_assets: 1,
                fbx_assets: 2,
                instances: 3,
            },
            Duration::from_millis(1),
            Duration::from_millis(2),
            Duration::from_millis(3),
            "error",
        );
        assert!(line.contains("\"gltfAssets\":1"));
        assert!(line.contains("\"fbxAssets\":2"));
        assert!(line.contains("\"instances\":3"));
        assert!(line.contains("\"queueMs\":1.000"));
        assert!(line.contains("\"decodeMs\":2.000"));
        assert!(line.contains("\"mainThreadMs\":3.000"));
        assert!(line.contains("\"outcome\":\"error\""));
        assert!(!line.contains("C:\\assets"));
    }

    #[test]
    fn asset_preflight_rejects_oversized_source_before_timeline_decode() {
        let path = temp_path("oversized-asset");
        let file = fs::File::create(&path).expect("create sparse asset");
        file.set_len(1024 * 1024 * 1024 + 1)
            .expect("size sparse asset");
        let document = Scene {
            version: 1,
            name: Some("Oversized".into()),
            assets: vec![SceneAsset {
                id: "asset".into(),
                kind: "fbx".into(),
                path: path.to_string_lossy().into_owned(),
            }],
            instances: Vec::new(),
            camera: None,
        };
        let resolved = vec![ResolvedAssetPath {
            asset_id: "asset".into(),
            stored_path: path.clone(),
            resolved_path: path.clone(),
            kind: AssetPathKind::AbsoluteLocal,
        }];

        let error = validate_resolved_assets(&document, &resolved).unwrap_err();
        assert!(error.contains("asset 'asset' failed preflight"));
        fs::remove_file(path).expect("remove sparse asset");
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
    fn scene_camera_state_rejects_degenerate_f32_view_basis() {
        let error = scene_camera_state(&document(SceneCamera {
            target: [1.0e20, 0.0, 0.0],
            yaw: 0.0,
            pitch: 0.0,
            distance: 4.0,
        }))
        .unwrap_err();
        assert!(error.contains("degenerate view basis"));
    }

    #[test]
    fn additive_import_keeps_latest_camera_when_preparation_has_no_camera() {
        let current = camera_state();
        let prepared = CameraState {
            target: [9.0, 8.0, 7.0],
            yaw: 1.0,
            pitch: -0.5,
            distance: 12.0,
        };

        let retained = replacement_camera_state(None, current);
        assert_eq!(retained.target, current.target);
        assert_eq!(retained.yaw, current.yaw);
        assert_eq!(retained.pitch, current.pitch);
        assert_eq!(retained.distance, current.distance);

        let replaced = replacement_camera_state(Some(prepared), current);
        assert_eq!(replaced.target, prepared.target);
        assert_eq!(replaced.yaw, prepared.yaw);
        assert_eq!(replaced.pitch, prepared.pitch);
        assert_eq!(replaced.distance, prepared.distance);
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
    fn replacement_guard_rejects_older_token_and_accepts_latest() {
        let state = SceneFileState::default();
        let path = PathBuf::from("current.scene.json");
        state.set_document(Scene::empty("Current"), Some(path));
        let before = state.status();
        let older = state.begin_replacement().expect("first replacement starts");
        let latest = state
            .begin_replacement()
            .expect("latest replacement starts");

        let stale = state
            .validate_replacement(older, None)
            .expect_err("older replacement must be rejected");
        assert!(stale.contains("stale"));
        assert_eq!(state.status().revision, before.revision);
        assert_eq!(state.status().path, before.path);
        assert!(state.validate_replacement(latest, None).is_ok());
        let duplicate = state
            .validate_replacement(latest, None)
            .expect_err("a committed token must not be reused");
        assert!(duplicate.contains("already committed"));
    }

    #[test]
    fn replacement_reservation_rejects_save_until_commit_finishes() {
        let state = SceneFileState::default();
        let path = PathBuf::from("current.scene.json");
        state.set_document(Scene::empty("Current"), Some(path.clone()));
        let token = state.begin_replacement().expect("replacement starts");
        state
            .validate_replacement(token, None)
            .expect("replacement reservation starts");

        let error = state
            .save(None, camera_state())
            .expect_err("save must not race replacement commit");
        assert!(error.contains("replacement is in progress"));
        assert_eq!(
            state.status().path,
            Some(path.to_string_lossy().into_owned())
        );
        let busy_new = state
            .begin_replacement()
            .expect_err("New/Open must reject while replacement commits");
        assert!(busy_new.contains("replacement is in progress"));
        let busy_import = state
            .begin_import()
            .expect_err("Import must reject while replacement commits");
        assert!(busy_import.contains("replacement is in progress"));
        state.release_replacement(token);

        state
            .begin_replacement()
            .expect("a new replacement may start after reservation release");
    }

    #[test]
    fn save_reservation_releases_lock_and_rejects_mutations() {
        let state = Arc::new(SceneFileState::default());
        let path = PathBuf::from("current.scene.json");
        state.set_document(document_with_instances(), Some(path));
        let preparation = state.begin_save(None).expect("save starts");

        let status_state = Arc::clone(&state);
        let status = std::thread::spawn(move || status_state.status())
            .join()
            .expect("status is not blocked by save preparation");
        assert_eq!(status.revision, preparation.token.revision);

        assert!(state
            .begin_replacement()
            .expect_err("replacement must reject during save")
            .contains("Scene save is in progress"));
        assert!(state
            .begin_import()
            .expect_err("import must reject during save")
            .contains("Scene save is in progress"));
        assert_eq!(
            state.set_instance_visibility("hero-1", false),
            SceneVisibilityMutation::NotPersistent
        );
        assert!(state
            .transact_instance_transform(
                "hero-1",
                SceneTransform {
                    translation: [1.0, 2.0, 3.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    scale: [1.0, 1.0, 1.0],
                },
                || Ok(())
            )
            .expect_err("transform must reject during save")
            .contains("Scene save is in progress"));
        assert!(state
            .save(None, camera_state())
            .expect_err("second save must reject during save")
            .contains("Scene save is in progress"));

        state.release_save(preparation.token);
    }

    #[test]
    fn complete_save_enforces_owner_and_revision_without_overwriting_memory() {
        let state = SceneFileState::default();
        let path = PathBuf::from("current.scene.json");
        state.set_document(Scene::empty("Current"), Some(path.clone()));
        let preparation = state.begin_save(None).expect("save starts");
        let before = state.status();

        let wrong_owner = SceneSaveToken {
            generation: preparation.token.generation.saturating_add(1),
            revision: preparation.token.revision,
        };
        let error = state
            .complete_save(wrong_owner, Scene::empty("Wrong Owner"), path.clone())
            .expect_err("wrong owner cannot complete save");
        assert!(error.contains("not owned"));
        assert_eq!(state.status().revision, before.revision);
        assert_eq!(state.status().path, before.path);
        state.release_save(preparation.token);

        let preparation = state.begin_save(None).expect("save starts again");
        state.set_document(Scene::empty("Changed"), Some(path.clone()));
        let error = state
            .complete_save(preparation.token, Scene::empty("Stale Save"), path.clone())
            .expect_err("revision change cannot complete save");
        assert!(error.contains("Scene changed"));
        assert_eq!(state.status().display_name, "current.scene.json");
        assert_eq!(
            state
                .document_snapshot()
                .expect("changed document remains")
                .0
                .name,
            Some("Changed".to_string())
        );
    }

    #[test]
    fn complete_replacement_rejects_missing_reservation_without_state_write() {
        let state = SceneFileState::default();
        let path = PathBuf::from("current.scene.json");
        state.set_document(Scene::empty("Current"), Some(path.clone()));
        let before = state.status();
        let token = state.begin_replacement().expect("replacement starts");
        state
            .validate_replacement(token, None)
            .expect("replacement reservation starts");
        state.release_replacement(token);

        let error = state
            .complete_replacement(token, Scene::empty("Should Not Commit"), None)
            .expect_err("released reservation cannot commit");
        assert!(error.contains("not owned"));
        assert_eq!(state.status().revision, before.revision);
        assert_eq!(state.status().path, before.path);
        assert_eq!(state.status().display_name, before.display_name);
    }

    #[test]
    fn import_guard_rejects_revision_mismatch_without_mutating_document() {
        let state = SceneFileState::default();
        let path = PathBuf::from("current.scene.json");
        let before = state.set_document(document_with_instances(), Some(path.clone()));
        let (token, _snapshot) = state.begin_import().expect("import starts");

        assert_eq!(
            state.set_instance_visibility("hero-1", false),
            SceneVisibilityMutation::Updated { previous: true }
        );
        let error = state
            .validate_replacement(token, Some(token.revision))
            .expect_err("document mutation must reject stale import");
        assert!(error.contains("Scene changed"));

        let after = state.document_snapshot().expect("document remains open");
        assert_eq!(after.1, Some(path));
        assert!(!after.0.instances[0].visible);
        assert_eq!(state.status().path, before.path);
        assert_eq!(state.status().revision, before.revision + 1);
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
                .canonicalize()
                .expect("canonicalize imported asset")
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
    fn instance_transform_transaction_updates_document_and_rolls_back_rejection() {
        let state = SceneFileState::default();
        let opened = state.set_document(document_with_instances(), None);
        let moved = SceneTransform {
            translation: [1.0, 2.0, 3.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.5, 1.5, 1.5],
        };
        let outcome = state
            .transact_instance_transform("hero-1", moved.clone(), || Ok(()))
            .expect("renderer accepts transform");
        assert!(matches!(outcome, SceneTransformMutation::Updated { .. }));
        let (document, _) = state.document_snapshot().expect("document remains open");
        assert_eq!(document.instances[0].transform, moved);
        assert_eq!(state.status().revision, opened.revision + 1);

        let rejected = SceneTransform {
            translation: [9.0, 9.0, 9.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
        };
        state
            .transact_instance_transform("hero-1", rejected, || Err("renderer rejected".into()))
            .expect_err("renderer rejection rolls back transform");
        let (document, _) = state.document_snapshot().expect("document remains open");
        assert_eq!(document.instances[0].transform, moved);
        assert_eq!(state.status().revision, opened.revision + 1);
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
