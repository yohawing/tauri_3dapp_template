mod camera;
#[cfg(target_os = "macos")]
mod macos_view;
mod performance;
mod protocol;
mod renderer;
mod renderer_status;
pub mod scene;
mod scene_file;
mod scene_projection;
mod timeline;
mod timeline_playback;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{Cursor, Read};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use camera::{validate_camera_state, OrbitCamera};
use protocol::{
    CameraSettings, CameraState, CameraViewPreset, ManipulatorMode, ManipulatorOrientation,
    ManipulatorSnapSettings, ViewportDisplayMode, ViewportDisplaySettings,
    ViewportEnvironmentSettings, ViewportInput, ViewportLightingSettings, ViewportRect,
};
use renderer::{Renderer, TransformHistoryRequest};
use scene::{diagnostic_path, diagnostic_text};
use scene_projection::{SceneCommandEnvelope, SceneCommandResult, SceneProjectionStore};

const SCENE_PROJECTION_CADENCE: Duration = Duration::from_millis(100);
const NATIVE_ACTIVE_WAKE_INTERVAL: Duration = Duration::from_millis(16);
const NATIVE_INACTIVE_WAKE_INTERVAL: Duration = Duration::from_millis(100);
const MAX_VIEWPORT_ENVIRONMENT_ENCODED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_VIEWPORT_ENVIRONMENT_PATH_BYTES: usize = 4096;
const MAX_VIEWPORT_ENVIRONMENT_DIMENSION: u32 = 16_384;
const MAX_VIEWPORT_ENVIRONMENT_DECODED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn native_wake_interval(active: bool) -> Duration {
    if active {
        NATIVE_ACTIVE_WAKE_INTERVAL
    } else {
        NATIVE_INACTIVE_WAKE_INTERVAL
    }
}

fn scene_projection_cadence_due(elapsed: Duration) -> bool {
    elapsed >= SCENE_PROJECTION_CADENCE
}

/// Scene projection work is cadence-limited while Native is rendering.  A
/// parked Native renderer still applies queued Scene commands and selection
/// requests so their acknowledgements remain observable, but an idle Canvas
/// backend must not rebuild the full DTO snapshot on every wake-up.
fn scene_projection_publish_due(active: bool, elapsed: Duration, has_scene_work: bool) -> bool {
    (active && scene_projection_cadence_due(elapsed)) || (!active && has_scene_work)
}

thread_local! {
    /// Kiss3d uses single-threaded scene graph internals (`Rc`/`RefCell`). Keep
    /// the renderer on Tauri's event-loop thread and share only DTO state with
    /// command handlers.
    static NATIVE_RENDERER: RefCell<Option<Renderer>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct RendererControl {
    viewport_rect: Mutex<Option<ViewportRect>>,
    viewport_inputs: Mutex<VecDeque<ViewportInput>>,
    manipulator_mode: Mutex<ManipulatorMode>,
    manipulator_orientation: Mutex<ManipulatorOrientation>,
    manipulator_snap: Mutex<ManipulatorSnapSettings>,
    transform_history_requests: Mutex<VecDeque<TransformHistoryRequest>>,
    viewport_display: Mutex<ViewportDisplaySettings>,
    camera_settings: Mutex<CameraSettings>,
    viewport_lighting: Mutex<ViewportLightingSettings>,
    viewport_environment: Mutex<ViewportEnvironmentControl>,
}

const MAX_VIEWPORT_INPUT_QUEUE: usize = 256;

fn enqueue_viewport_input(
    queue: &mut VecDeque<ViewportInput>,
    input: ViewportInput,
) -> Result<(), String> {
    let is_move = matches!(input, ViewportInput::PointerMove { .. });
    if is_move {
        if let Some(last) = queue.back_mut() {
            if matches!(last, ViewportInput::PointerMove { .. }) {
                *last = input;
                return Ok(());
            }
        }
        if queue.len() >= MAX_VIEWPORT_INPUT_QUEUE {
            if let Some(index) = queue
                .iter()
                .position(|queued| matches!(queued, ViewportInput::PointerMove { .. }))
            {
                queue.remove(index);
            } else {
                return Ok(());
            }
        }
        queue.push_back(input);
        return Ok(());
    }

    if queue.len() >= MAX_VIEWPORT_INPUT_QUEUE {
        if let Some(index) = queue
            .iter()
            .position(|queued| matches!(queued, ViewportInput::PointerMove { .. }))
        {
            queue.remove(index);
        } else {
            return Err("viewport input queue is full; boundary input was rejected".into());
        }
    }
    queue.push_back(input);
    Ok(())
}

#[derive(Default)]
struct ViewportEnvironmentControl {
    latest_sequence: u64,
    revision: u64,
    settings: ViewportEnvironmentSettings,
    encoded: Option<Arc<Vec<u8>>>,
}

fn accept_viewport_environment_sequence(
    control: &mut ViewportEnvironmentControl,
    sequence: u64,
) -> Result<(), String> {
    if sequence == 0 || sequence > MAX_JS_SAFE_INTEGER {
        return Err(format!(
            "HDRI request sequence must be between 1 and JavaScript safe integer {MAX_JS_SAFE_INTEGER}"
        ));
    }
    if sequence < control.latest_sequence {
        return Err("HDRI request was superseded".into());
    }
    control.latest_sequence = sequence;
    Ok(())
}

/// Diagnostic-only state for `[viewport-rect]` logging (see
/// `set_viewport_rect`). Deliberately kept separate from `Renderer`: by the
/// time a rect reaches `Renderer` it has already been converted from the
/// wire-format CSS-pixel `ViewportRect` into a physical-pixel tuple
/// (`viewport_px`), which is the representation the render loop cares about.
/// The *previous raw `ViewportRect`* (for IPC-level dedup) and a log
/// sequence number are purely a diagnostic concern of this command, not
/// something the renderer needs to know about, so they get their own managed
/// state independent from the renderer runtime.
#[derive(Default)]
struct ViewportRectLog {
    last: Mutex<Option<ViewportRect>>,
    seq: AtomicU64,
}

/// Whether `[viewport-rect]` diagnostic logging is enabled, read once from
/// the `TAURI3D_LOG_VIEWPORT_RECT` env var (any value other than unset or
/// `"0"` enables it). An env var (rather than `#[cfg(debug_assertions)]`) is
/// used so the logging can be toggled per-run without needing a rebuild —
/// useful since dev builds are already noisy and this is opt-in
/// instrumentation for one specific verification task, not something that
/// should print on every debug run.
fn viewport_rect_logging_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("TAURI3D_LOG_VIEWPORT_RECT")
            .map(|v| v != "0")
            .unwrap_or(false)
    })
}

#[tauri::command]
fn set_viewport_rect(
    window: tauri::WebviewWindow,
    state: tauri::State<RendererControl>,
    log: tauri::State<ViewportRectLog>,
    mut rect: ViewportRect,
) -> Result<(), String> {
    // The native surface is sized in physical pixels. On macOS WKWebView's
    // reported devicePixelRatio can briefly disagree with the NSWindow backing
    // scale while moving between displays, which shifts both rendering and
    // gizmo hit-testing. Use the surface owner's scale factor as the authority.
    let native_scale = window
        .scale_factor()
        .map_err(|error| format!("failed to read native window scale factor: {error}"))?
        as f32;
    if !native_scale.is_finite() || native_scale <= 0.0 {
        return Err("native window scale factor must be finite and positive".into());
    }
    rect.scale_factor = native_scale;

    // A transparent Tauri window uses a full-height Wry parent view on macOS,
    // while WKWebView's visible CSS origin begins below the title bar. Place
    // the native surface viewport at that same origin. This is intentionally
    // a translation only; pointer-local Y remains top-down and is not flipped.
    #[cfg(target_os = "macos")]
    {
        rect.y += macos_view::webview_top_inset(&window)?;
    }

    if viewport_rect_logging_enabled() {
        let mut last = log.last.lock().unwrap();
        if *last != Some(rect) {
            let seq = log.seq.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "[viewport-rect] #{seq} x={:.1} y={:.1} w={:.1} h={:.1} scale={:.2}",
                rect.x, rect.y, rect.width, rect.height, rect.scale_factor
            );
            *last = Some(rect);
        }
    }

    *state.viewport_rect.lock().unwrap() = Some(rect);
    Ok(())
}

#[tauri::command]
fn set_manipulator_mode(
    state: tauri::State<RendererControl>,
    mode: ManipulatorMode,
) -> ManipulatorMode {
    *state.manipulator_mode.lock().unwrap() = mode;
    mode
}

#[tauri::command]
fn set_manipulator_orientation(
    state: tauri::State<RendererControl>,
    orientation: ManipulatorOrientation,
) -> ManipulatorOrientation {
    *state.manipulator_orientation.lock().unwrap() = orientation;
    orientation
}

#[tauri::command(rename_all = "camelCase")]
fn set_manipulator_snap(
    state: tauri::State<RendererControl>,
    mut settings: ManipulatorSnapSettings,
) -> Result<ManipulatorSnapSettings, String> {
    if !settings.translate_increment.is_finite()
        || settings.translate_increment <= 0.0
        || settings.translate_increment > 1_000.0
        || !settings.rotate_degrees.is_finite()
        || settings.rotate_degrees <= 0.0
        || settings.rotate_degrees > 180.0
        || !settings.scale_increment.is_finite()
        || settings.scale_increment <= 0.0
        || settings.scale_increment > 100.0
    {
        return Err("manipulator snap increments must be finite and positive".into());
    }
    // Keep values stable for future persistence/UI round trips.
    settings.translate_increment = settings.translate_increment.max(f32::EPSILON);
    settings.rotate_degrees = settings.rotate_degrees.max(f32::EPSILON);
    settings.scale_increment = settings.scale_increment.max(f32::EPSILON);
    *state.manipulator_snap.lock().unwrap() = settings;
    Ok(settings)
}

fn request_transform_history(
    state: tauri::State<RendererControl>,
    request: TransformHistoryRequest,
) -> Result<(), String> {
    let mut queue = state.transform_history_requests.lock().unwrap();
    if queue.len() >= 32 {
        return Err("transform history request queue is full".into());
    }
    queue.push_back(request);
    Ok(())
}

#[tauri::command]
fn undo_transform(state: tauri::State<RendererControl>) -> Result<(), String> {
    request_transform_history(state, TransformHistoryRequest::Undo)
}

#[tauri::command]
fn redo_transform(state: tauri::State<RendererControl>) -> Result<(), String> {
    request_transform_history(state, TransformHistoryRequest::Redo)
}

#[tauri::command(rename_all = "camelCase")]
fn set_viewport_display(
    state: tauri::State<RendererControl>,
    mode: ViewportDisplayMode,
    show_grid: bool,
    show_bones: bool,
) -> Result<ViewportDisplaySettings, String> {
    let settings = ViewportDisplaySettings {
        mode,
        show_grid,
        show_bones,
    };
    *state.viewport_display.lock().unwrap() = settings;
    Ok(settings)
}

#[tauri::command(rename_all = "camelCase")]
fn set_camera_settings(
    state: tauri::State<RendererControl>,
    settings: CameraSettings,
) -> Result<CameraSettings, String> {
    if !settings.fov_degrees.is_finite() || !(1.0..=179.0).contains(&settings.fov_degrees) {
        return Err("Camera FOV must be finite and between 1 and 179 degrees".into());
    }
    *state.camera_settings.lock().unwrap() = settings;
    Ok(settings)
}

fn validate_viewport_lighting(settings: &ViewportLightingSettings) -> Result<(), String> {
    if !settings.exposure.is_finite() || !(0.0..=16.0).contains(&settings.exposure) {
        return Err("Viewport exposure must be finite and between 0 and 16".into());
    }
    if !settings.ambient_intensity.is_finite() || !(0.0..=4.0).contains(&settings.ambient_intensity)
    {
        return Err("Ambient intensity must be finite and between 0 and 4".into());
    }
    if settings
        .ambient_color
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("Ambient color channels must be finite and between 0 and 1".into());
    }
    if !matches!(settings.shadow_resolution, 512 | 1024 | 2048) {
        return Err("Shadow resolution must be 512, 1024, or 2048".into());
    }
    if !settings.shadow_softness.is_finite() || !(0.0..=8.0).contains(&settings.shadow_softness) {
        return Err("Shadow softness must be finite and between 0 and 8".into());
    }
    if settings
        .background_color
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("Background color channels must be finite and between 0 and 1".into());
    }
    Ok(())
}

#[tauri::command]
fn set_viewport_lighting(
    state: tauri::State<RendererControl>,
    settings: ViewportLightingSettings,
) -> Result<ViewportLightingSettings, String> {
    validate_viewport_lighting(&settings)?;
    *state.viewport_lighting.lock().unwrap() = settings;
    Ok(settings)
}

fn validate_viewport_environment(settings: &ViewportEnvironmentSettings) -> Result<(), String> {
    if settings.path.len() > MAX_VIEWPORT_ENVIRONMENT_PATH_BYTES {
        return Err(format!(
            "HDRI path exceeds the {MAX_VIEWPORT_ENVIRONMENT_PATH_BYTES}-byte limit"
        ));
    }
    if !settings.rotation_degrees.is_finite()
        || !(-180.0..=180.0).contains(&settings.rotation_degrees)
    {
        return Err("HDRI rotation must be finite and between -180 and 180 degrees".into());
    }
    if !settings.intensity.is_finite() || !(0.0..=8.0).contains(&settings.intensity) {
        return Err("HDRI intensity must be finite and between 0 and 8".into());
    }
    if settings.enabled {
        if settings.path.trim().is_empty() {
            return Err("HDRI path is required while the environment is enabled".into());
        }
        if !Path::new(&settings.path).is_absolute() {
            return Err("HDRI path must be absolute".into());
        }
    }
    Ok(())
}

fn validate_viewport_environment_encoded_size(size: u64) -> Result<(), String> {
    if size > MAX_VIEWPORT_ENVIRONMENT_ENCODED_BYTES {
        return Err(format!(
            "HDRI file exceeds the {} MiB encoded size limit",
            MAX_VIEWPORT_ENVIRONMENT_ENCODED_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

fn decode_viewport_environment(bytes: &[u8]) -> Result<(), String> {
    validate_viewport_environment_encoded_size(bytes.len() as u64)?;
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("failed to identify HDRI format: {error}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_VIEWPORT_ENVIRONMENT_DIMENSION);
    limits.max_image_height = Some(MAX_VIEWPORT_ENVIRONMENT_DIMENSION);
    limits.max_alloc = Some(MAX_VIEWPORT_ENVIRONMENT_DECODED_BYTES);
    reader.limits(limits);
    reader
        .decode()
        .map(|_| ())
        .map_err(|error| format!("HDRI dimensions or decoded allocation exceed limits: {error}"))
}

#[tauri::command]
async fn set_viewport_environment(
    state: tauri::State<'_, RendererControl>,
    settings: ViewportEnvironmentSettings,
    sequence: u64,
) -> Result<ViewportEnvironmentSettings, String> {
    // Reject malformed payloads before reserving a sequence. An invalid
    // request must not supersede a later valid request with a lower sequence.
    validate_viewport_environment(&settings)?;
    let cached = {
        let mut control = state.viewport_environment.lock().unwrap();
        accept_viewport_environment_sequence(&mut control, sequence)?;
        (control.settings.path == settings.path)
            .then(|| control.encoded.clone())
            .flatten()
    };

    // File I/O and image validation can take several seconds for a 4K EXR.
    // Keep it outside the render-loop mutex, then use the sequence to prevent
    // an older load from overwriting a newer Clear or orientation request.
    let encoded = if settings.enabled {
        if let Some(cached) = cached {
            Some(cached)
        } else {
            let path = settings.path.clone();
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                let metadata = std::fs::metadata(&path).map_err(|error| {
                    format!(
                        "Failed to inspect HDRI '{}': {}",
                        diagnostic_path(Path::new(&path)),
                        diagnostic_text(&error.to_string())
                    )
                })?;
                validate_viewport_environment_encoded_size(metadata.len())?;
                let bytes =
                    read_bounded_file(Path::new(&path), MAX_VIEWPORT_ENVIRONMENT_ENCODED_BYTES)
                        .map_err(|error| {
                            format!(
                                "Failed to read HDRI '{}': {}",
                                diagnostic_path(Path::new(&path)),
                                diagnostic_text(&error.to_string())
                            )
                        })?;
                decode_viewport_environment(&bytes).map_err(|error| {
                    format!(
                        "Failed to decode HDRI '{}': {}",
                        diagnostic_path(Path::new(&path)),
                        diagnostic_text(&error)
                    )
                })?;
                Ok::<_, String>(bytes)
            })
            .await
            .map_err(|error| format!("HDRI decode task failed: {error}"))??;
            Some(Arc::new(bytes))
        }
    } else {
        cached
    };

    let mut control = state.viewport_environment.lock().unwrap();
    if sequence != control.latest_sequence {
        return Err("HDRI request was superseded".into());
    }
    control.encoded = if settings.path.is_empty() {
        None
    } else {
        encoded
    };
    control.settings = settings.clone();
    control.revision = control.revision.saturating_add(1);
    Ok(settings)
}

fn read_bounded_file(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Generic input entry point for the ViewportHost: pointer/wheel events are
/// forwarded here as tagged values. The event-loop thread gives the native
/// manipulator first refusal, then passes unconsumed events to the orbit
/// camera so both interactions share one ordered input stream.
#[tauri::command]
fn viewport_input(
    app: tauri::AppHandle,
    state: tauri::State<RendererControl>,
    input: ViewportInput,
) -> Result<(), String> {
    input.validate()?;
    enqueue_viewport_input(&mut state.viewport_inputs.lock().unwrap(), input)?;
    // Pointer hover must not wait behind the periodic render wake. Posting an
    // event immediately lets MainEventsCleared consume the latest coalesced
    // position and redraw gizmo highlighting without a visible trailing lag.
    let _ = app.run_on_main_thread(|| {});
    Ok(())
}

/// Toggles the native renderer on/off so the frontend can hand the viewport
/// over to (or reclaim it from) a Canvas fallback. When inactive,
/// `MainEventsCleared` skips rendering entirely; resize still reconfigures
/// the surface so reactivation is clean.
#[tauri::command]
fn set_renderer_active(
    app: tauri::AppHandle,
    status: tauri::State<renderer_status::RendererStatusStore>,
    playback_store: tauri::State<timeline_playback::TimelinePlaybackStore>,
    state: tauri::State<RendererControl>,
    active: bool,
) -> Result<renderer_status::RendererStatus, String> {
    if !active {
        // A backend switch can race the React input effect cleanup. Queue the
        // same cancel semantic used by pointercancel so the render-loop state
        // is cleared even if the detach command arrives later (or is skipped
        // by a stale frontend generation).
        let mut queue = state.viewport_inputs.lock().unwrap();
        // Cancellation supersedes every queued event from the detached
        // gesture. Clear first so the boundary cannot be rejected by a full
        // queue and no stale move/down/up can run after deactivation.
        queue.clear();
        queue.push_back(ViewportInput::PointerCancel);

        // Close playback admission before publishing the inactive lifecycle
        // state. Requests racing this boundary are rejected or cleared rather
        // than surviving into the next Native activation.
        playback_store.set_accepting_commands(false);
    }
    let result = status.set_active(active);
    if result.is_ok() {
        if active {
            // Publish the active lifecycle first; only then admit new playback
            // commands for the reactivated Native renderer.
            playback_store.set_accepting_commands(true);
        }
        // Interrupt an inactive 100ms cadence immediately when Canvas hands
        // the viewport back to Native (or vice versa).
        let _ = app.run_on_main_thread(|| {});
    }
    result
}

#[tauri::command]
fn get_renderer_status(
    state: tauri::State<renderer_status::RendererStatusStore>,
) -> renderer_status::RendererStatus {
    state.status()
}

#[tauri::command]
fn get_camera(state: tauri::State<Mutex<OrbitCamera>>) -> CameraState {
    state.lock().unwrap().state()
}

fn native_tick_should_render(tick_active: bool, lifecycle_active: bool) -> bool {
    tick_active && lifecycle_active
}

fn cancel_native_drag(
    renderer: &mut Renderer,
    scene_file_state: &scene_file::SceneFileState,
    camera_state: &Mutex<OrbitCamera>,
) {
    // Lifecycle cancellation has the same atomic rollback contract as
    // pointercancel.  The event-loop owns the renderer, so apply the exact
    // drag-start transform before clearing camera orbit state.
    if let Some(rollback) = renderer.cancel_manipulator_drag() {
        if let Err(error) = apply_transform_update(
            renderer,
            scene_file_state,
            &rollback.node_id,
            rollback.transform,
        ) {
            eprintln!(
                "native manipulator lifecycle rollback rejected: {}",
                diagnostic_text(&error)
            );
        }
    }
    camera_state
        .lock()
        .unwrap()
        .handle_input(ViewportInput::PointerCancel);
}

#[tauri::command]
fn set_camera(state: tauri::State<Mutex<OrbitCamera>>, camera: CameraState) -> Result<(), String> {
    validate_camera_state(&camera)?;
    state.lock().unwrap().set_state(camera);
    Ok(())
}

#[tauri::command]
fn set_camera_view(state: tauri::State<Mutex<OrbitCamera>>, preset: CameraViewPreset) {
    state.lock().unwrap().set_view_preset(preset);
}

#[tauri::command]
fn get_scene_projection(
    state: tauri::State<SceneProjectionStore>,
) -> scene_projection::SceneProjection {
    state.projection()
}

#[tauri::command(rename_all = "camelCase")]
fn select_scene_node(
    state: tauri::State<SceneProjectionStore>,
    node_id: String,
) -> Result<(), String> {
    state.request_selection(node_id)
}

#[tauri::command]
fn dispatch_scene_command(
    state: tauri::State<SceneProjectionStore>,
    command: SceneCommandEnvelope,
) -> Result<(), String> {
    state.request_command(command)
}

fn apply_transform_update(
    renderer: &mut Renderer,
    scene_file_state: &scene_file::SceneFileState,
    node_id: &str,
    transform: scene_projection::SceneTransform,
) -> Result<(), String> {
    transform.validate()?;
    let command = scene_projection::SceneCommand::SetTransform {
        node_id: node_id.to_string(),
        transform: transform.clone(),
    };
    if !renderer.is_runtime_instance(node_id) {
        return renderer.apply_scene_command(command);
    }

    let document_transform = scene::SceneTransform {
        translation: transform.translation.map(f64::from),
        rotation: transform.rotation.map(f64::from),
        scale: transform.scale.map(f64::from),
    };
    scene_file_state
        .transact_instance_transform(node_id, document_transform, || {
            renderer.apply_scene_command(command)
        })
        .and_then(|mutation| match mutation {
            scene_file::SceneTransformMutation::Updated { .. } => Ok(()),
            scene_file::SceneTransformMutation::NotPersistent => Err(format!(
                "renderer/document mismatch for runtime instance '{node_id}'"
            )),
        })
}

#[tauri::command]
fn get_timeline_projection(
    state: tauri::State<timeline::TimelineProjectionStore>,
) -> timeline::TimelineProjection {
    state.projection()
}

#[tauri::command]
fn get_timeline_playback(
    state: tauri::State<timeline_playback::TimelinePlaybackStore>,
) -> timeline_playback::TimelinePlaybackSnapshot {
    state.snapshot()
}

#[tauri::command]
fn dispatch_timeline_playback(
    state: tauri::State<timeline_playback::TimelinePlaybackStore>,
    command: timeline_playback::TimelinePlaybackCommandEnvelope,
) -> Result<(), String> {
    state.request(command)
}

const MAX_PERFORMANCE_SUMMARY_BYTES: usize = 64 * 1024;

#[tauri::command]
fn report_performance_summary(summary: serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_vec(&summary)
        .map_err(|error| format!("performance summary serialization failed: {error}"))?;
    if payload.len() > MAX_PERFORMANCE_SUMMARY_BYTES {
        return Err(format!(
            "performance summary exceeds the {MAX_PERFORMANCE_SUMMARY_BYTES}-byte limit"
        ));
    }
    let diagnostic = diagnostic_text(&summary.to_string());
    eprintln!("[perf] {diagnostic}");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            set_viewport_rect,
            set_manipulator_mode,
            set_manipulator_orientation,
            set_manipulator_snap,
            undo_transform,
            redo_transform,
            set_viewport_display,
            set_camera_settings,
            set_viewport_lighting,
            set_viewport_environment,
            viewport_input,
            set_renderer_active,
            get_renderer_status,
            get_camera,
            set_camera,
            set_camera_view,
            get_scene_projection,
            select_scene_node,
            dispatch_scene_command,
            get_timeline_projection,
            get_timeline_playback,
            dispatch_timeline_playback,
            report_performance_summary,
            scene_file::get_scene_file_status,
            scene_file::new_scene_file,
            scene_file::open_scene_file,
            scene_file::import_scene_asset,
            scene_file::save_scene_file
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Tauri configuration did not create the required 'main' window",
                )
            })?;
            let size = window.inner_size()?;

            let configured_scene = std::env::var_os("TAURI3D_SCENE");
            let (renderer, initial_camera, timeline_projection, opened_scene) = match configured_scene {
                None => {
                    let renderer = Renderer::new(window, (size.width, size.height));
                    (
                        renderer,
                        OrbitCamera::default().state(),
                        timeline::TimelineProjection::default(),
                        None,
                    )
                }
                Some(scene_path) => {
                    let scene_path = PathBuf::from(scene_path);
                    scene_file::validate_scene_status_path(&scene_path).map_err(|error| {
                        format!(
                            "TAURI3D_SCENE '{}' failed status validation: {}",
                            diagnostic_path(&scene_path),
                            diagnostic_text(&error)
                        )
                    })?;
                    let document = scene::Scene::load(&scene_path).map_err(|error| {
                        format!(
                            "TAURI3D_SCENE '{}' failed before renderer startup: {}",
                            diagnostic_path(&scene_path),
                            diagnostic_text(&error.to_string())
                        )
                    })?;
                    // Scene::load performs the existence check.  Resolve again here to retain
                    // the absolute paths needed by the native runtime builder.
                    let resolved_assets =
                        document.resolve_asset_paths(&scene_path).map_err(|error| {
                            format!(
                                "TAURI3D_SCENE '{}' path resolution failed: {}",
                                diagnostic_path(&scene_path),
                                diagnostic_text(&error.to_string())
                            )
                        })?;
                    let initial_camera = scene_file::scene_camera_state(&document).map_err(|error| {
                        format!(
                            "TAURI3D_SCENE '{}' camera initialization failed: {}",
                            diagnostic_path(&scene_path),
                            diagnostic_text(&error)
                        )
                    })?;
                    let renderer = Renderer::new_from_scene(
                        window,
                        (size.width, size.height),
                        &document,
                        &resolved_assets,
                    )
                    .map_err(|error| {
                        format!(
                            "TAURI3D_SCENE '{}' native runtime construction failed: {}",
                            diagnostic_path(&scene_path),
                            diagnostic_text(&error.to_string())
                        )
                    })?;
                    let timeline_projection =
                        timeline::load_scene_timeline(&document, &resolved_assets).map_err(
                            |error| {
                                format!(
                                    "TAURI3D_SCENE '{}' animation metadata failed: {}",
                                    diagnostic_path(&scene_path),
                                    diagnostic_text(&error)
                                )
                            },
                        )?;
                    (
                        renderer,
                        initial_camera,
                        timeline_projection,
                        Some((document, scene_path)),
                    )
                }
            };
            let runtime_clip_count = renderer.animation_clip_count();
            if runtime_clip_count != timeline_projection.clips.len() {
                return Err(format!(
                    "animation metadata/runtime mismatch: projection has {} clips but native loader retained {runtime_clip_count}",
                    timeline_projection.clips.len()
                )
                .into());
            }
            let projection_store = SceneProjectionStore::default();
            projection_store.publish(renderer.scene_projection(Some(renderer.default_node_id())));
            let forced_failure = std::env::var("TAURI3D_FORCE_NATIVE_FAILURE")
                .ok()
                .filter(|value| value != "0")
                .map(|_| {
                    "Injected Native renderer failure (TAURI3D_FORCE_NATIVE_FAILURE)".to_string()
                });
            let renderer_status = match forced_failure {
                Some(reason) => renderer_status::RendererStatus::unavailable_with_hint(
                    reason,
                    "Restart without TAURI3D_FORCE_NATIVE_FAILURE to retry Native wgpu",
                ),
                None => renderer_status::RendererStatus::available(),
            };
            // Kiss3d owns thread-local GPU resources whose destruction must stay on
            // the event-loop thread. Even an unavailable renderer remains parked in
            // this slot; the lifecycle store prevents drawing and rejects
            // reactivation until the process is restarted without the fault.
            let initial_playback = renderer.timeline_playback_snapshot();
            NATIVE_RENDERER.with(|slot| {
                *slot.borrow_mut() = Some(renderer);
            });
            let mut camera = OrbitCamera::default();
            camera.set_state(initial_camera);
            app.manage(Mutex::new(camera));
            let renderer_status_store = renderer_status::RendererStatusStore::new(renderer_status);
            let initial_native_active = renderer_status_store.is_active();
            app.manage(renderer_status_store);
            let device = kiss3d::context::Context::get().device;
            let device_lost_handle = app.handle().clone();
            device.set_device_lost_callback(move |reason, message| {
                let detail = if message.is_empty() {
                    format!("wgpu device lost ({reason:?})")
                } else {
                    format!("wgpu device lost ({reason:?}): {message}")
                };
                let status_store = device_lost_handle
                    .state::<renderer_status::RendererStatusStore>();
                if let Some(status) = status_store.mark_unavailable_once(detail) {
                    if let Err(error) =
                        device_lost_handle.emit("renderer-status-changed", status)
                    {
                        eprintln!("failed to emit renderer status after Device Lost: {error}");
                    }
                    let _ = device_lost_handle.run_on_main_thread(|| {});
                }
            });
            let uncaptured_error_handle = app.handle().clone();
            device.on_uncaptured_error(Arc::new(move |error| {
                if let Some(reason) = renderer_status::uncaptured_error_fallback_reason(&error) {
                    let status_store = uncaptured_error_handle
                        .state::<renderer_status::RendererStatusStore>();
                    if let Some(status) = status_store.mark_unavailable_once(reason) {
                        if let Err(error) =
                            uncaptured_error_handle.emit("renderer-status-changed", status)
                        {
                            eprintln!(
                                "failed to emit renderer status after wgpu OutOfMemory: {error}"
                            );
                        }
                        let _ = uncaptured_error_handle.run_on_main_thread(|| {});
                    }
                    return;
                }

                // Keep wgpu's default fatal behavior for validation/internal
                // errors rather than silently masking a renderer bug.
                panic!(
                    "{}",
                    renderer_status::uncaptured_error_panic_message(&error)
                );
            }));
            if std::env::var("TAURI3D_FORCE_DEVICE_LOST")
                .is_ok_and(|value| value != "0")
            {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    device.destroy();
                });
            }
            app.manage(RendererControl::default());
            app.manage(ViewportRectLog::default());
            app.manage(projection_store);
            app.manage(timeline::TimelineProjectionStore::new(timeline_projection));
            let playback_store = timeline_playback::TimelinePlaybackStore::default();
            playback_store.publish(initial_playback);
            playback_store.set_accepting_commands(initial_native_active);
            app.manage(playback_store);
            let scene_file_state = scene_file::SceneFileState::default();
            if let Some((document, path)) = opened_scene {
                scene_file_state.set_document(document, Some(path));
            }
            app.manage(scene_file_state);

            // tauri-runtime-wry hard-resets tao's ControlFlow to `Wait` on every
            // loop iteration (it never lets user code switch to `Poll`), so
            // `RunEvent::MainEventsCleared` only fires in response to an actual
            // incoming event. Without a steady stream of those, the loop goes
            // idle right after startup and the render() call in
            // MainEventsCleared stops firing — the cube would freeze on its
            // first frame. Wake the loop with a no-op main-thread task;
            // `run_on_main_thread` posts through the tao `EventLoopProxy`,
            // which interrupts `Wait` and drives another `MainEventsCleared`
            // right after. Native renders keep a ~60Hz cadence while an
            // inactive Canvas handoff only needs a ~10Hz command/poll wake.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let active = handle
                    .state::<renderer_status::RendererStatusStore>()
                    .is_active();
                std::thread::sleep(native_wake_interval(active));
                if handle.run_on_main_thread(|| {}).is_err() {
                    break;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("failed to build Tauri application: {error}");
            return;
        }
    };
    let mut last_scene_projection_publish = Instant::now();
    let mut last_viewport_environment_revision = 0;
    // Reuse the event-loop-owned input deque between ticks. Taking the shared
    // queue into a fresh local each frame would drop its allocation and make
    // continuous pointer drags allocate on every wake.
    let mut native_viewport_inputs = VecDeque::new();
    app.run(move |app_handle, event| match event {
            RunEvent::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                NATIVE_RENDERER.with(|slot| {
                    if let Some(renderer) = slot.borrow_mut().as_mut() {
                        renderer.resize(size.width, size.height);
                    }
                });
            }
            RunEvent::WindowEvent {
                event:
                    WindowEvent::ScaleFactorChanged {
                        scale_factor,
                        new_inner_size,
                        ..
                    },
                ..
            } => {
                let scale_factor = scale_factor as f32;
                if scale_factor.is_finite() && scale_factor > 0.0 {
                    let renderer_control = app_handle.state::<RendererControl>();
                    let mut viewport_rect = renderer_control.viewport_rect.lock().unwrap();
                    if let Some(rect) = viewport_rect.as_mut() {
                        rect.scale_factor = scale_factor;
                    }
                }
                NATIVE_RENDERER.with(|slot| {
                    if let Some(renderer) = slot.borrow_mut().as_mut() {
                        renderer.resize(new_inner_size.width, new_inner_size.height);
                    }
                });
            }
            RunEvent::MainEventsCleared => {
                let camera_state = app_handle.state::<Mutex<OrbitCamera>>();
                let renderer_control = app_handle.state::<RendererControl>();
                let viewport_rect = *renderer_control.viewport_rect.lock().unwrap();
                native_viewport_inputs.append(&mut *renderer_control.viewport_inputs.lock().unwrap());
                let manipulator_mode = *renderer_control.manipulator_mode.lock().unwrap();
                let manipulator_orientation = *renderer_control
                    .manipulator_orientation
                    .lock()
                    .unwrap();
                let manipulator_snap = *renderer_control.manipulator_snap.lock().unwrap();
                let mut transform_history_requests = std::mem::take(
                    &mut *renderer_control.transform_history_requests.lock().unwrap(),
                );
                let viewport_display = *app_handle
                    .state::<RendererControl>()
                    .viewport_display
                    .lock()
                    .unwrap();
                let camera_settings = *app_handle
                    .state::<RendererControl>()
                    .camera_settings
                    .lock()
                    .unwrap();
                let viewport_lighting = *app_handle
                    .state::<RendererControl>()
                    .viewport_lighting
                    .lock()
                    .unwrap();
                let viewport_environment = {
                    let renderer_control = app_handle.state::<RendererControl>();
                    let environment = renderer_control.viewport_environment.lock().unwrap();
                    (environment.revision != last_viewport_environment_revision).then(|| {
                        (
                            environment.revision,
                            environment.settings.clone(),
                            environment.encoded.clone(),
                        )
                    })
                };
                let lifecycle_store = app_handle.state::<renderer_status::RendererStatusStore>();
                let active = lifecycle_store.is_active();
                let projection_store = app_handle.state::<SceneProjectionStore>();
                let playback_store =
                    app_handle.state::<timeline_playback::TimelinePlaybackStore>();
                let commands = projection_store.take_commands();
                let mut playback_commands = Some(playback_store.take_commands());
                let current_selection = projection_store.selected_node_id();
                let requested_selection = projection_store.take_selection();
                let has_scene_work = !commands.is_empty() || requested_selection.is_some();
                let selected_id = requested_selection.or(current_selection);
                let scene_file_state = app_handle.state::<scene_file::SceneFileState>();
                let mut native_render_active =
                    native_tick_should_render(active, lifecycle_store.is_active());

                NATIVE_RENDERER.with(|slot| {
                    if let Some(renderer) = slot.borrow_mut().as_mut() {
                        let playback_commands = playback_commands.take().unwrap_or_default();
                        for envelope in commands {
                            let node_id = envelope.command.node_id().to_string();
                            let property = envelope.command.property().to_string();
                            let sequence = envelope.sequence;
                            if !projection_store.is_current_epoch(&envelope) {
                                projection_store.record_command_result(SceneCommandResult {
                                    sequence,
                                    node_id,
                                    property,
                                    applied: false,
                                    error: Some("stale scene epoch".to_string()),
                                });
                                continue;
                            }
                            let transform_before = match &envelope.command {
                                scene_projection::SceneCommand::SetTransform { node_id, .. } => {
                                    renderer.editable_transform(node_id)
                                }
                                _ => None,
                            };
                            let result = match &envelope.command {
                                scene_projection::SceneCommand::SetTransform {
                                    node_id,
                                    transform,
                                } => apply_transform_update(
                                    renderer,
                                    &scene_file_state,
                                    node_id,
                                    transform.clone(),
                                ),
                                scene_projection::SceneCommand::SetVisibility {
                                    node_id,
                                    visible,
                                } if renderer.is_runtime_instance(node_id) => {
                                    match scene_file_state.transact_instance_visibility(
                                        node_id,
                                        *visible,
                                        || renderer.apply_scene_command(envelope.command.clone()),
                                    ) {
                                        Ok(scene_file::SceneVisibilityMutation::Updated {
                                            ..
                                        }) => Ok(()),
                                        Ok(scene_file::SceneVisibilityMutation::NotPersistent) => {
                                            Err(format!(
                                                "renderer/document mismatch for runtime instance '{node_id}'"
                                            ))
                                        }
                                        Err(error) => Err(error),
                                    }
                                }
                                _ => renderer.apply_scene_command(envelope.command.clone()),
                            };
                            if result.is_ok() {
                                if let (
                                    Some(before),
                                    scene_projection::SceneCommand::SetTransform {
                                        node_id,
                                        transform,
                                    },
                                ) = (transform_before, &envelope.command)
                                {
                                    renderer.record_transform_history(
                                        node_id.clone(),
                                        before,
                                        transform.clone(),
                                    );
                                }
                            }
                            projection_store.record_command_result(SceneCommandResult {
                                sequence,
                                node_id,
                                property,
                                applied: result.is_ok(),
                                error: result.err(),
                            });
                        }
                        native_render_active = native_tick_should_render(
                            native_render_active,
                            lifecycle_store.is_active(),
                        );
                        for envelope in playback_commands {
                            let result = if !native_render_active
                                || !native_tick_should_render(
                                    native_render_active,
                                    lifecycle_store.is_active(),
                                )
                            {
                                native_render_active = false;
                                Err("Native renderer is inactive".to_string())
                            } else if !playback_store.is_current_epoch(&envelope) {
                                Err(format!(
                                    "stale timeline playback epoch {}",
                                    envelope.epoch
                                ))
                            } else {
                                renderer.apply_timeline_playback_command(envelope.command.clone())
                            };
                            if let Err(error) = &result {
                                eprintln!(
                                    "timeline playback command rejected: {}",
                                    diagnostic_text(error)
                                );
                            }
                            playback_store.record_command_result(&envelope, result);
                        }
                        let selected_id = selected_id
                            .as_deref()
                            .filter(|id| renderer.has_node(id))
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| renderer.default_node_id().to_string());
                        native_render_active = native_tick_should_render(
                            native_render_active,
                            lifecycle_store.is_active(),
                        );
                        if native_render_active {
                            renderer.set_manipulator_orientation(manipulator_orientation);
                            renderer.set_manipulator_snap(manipulator_snap);
                            if let Some(rect) = viewport_rect {
                                renderer::apply_viewport_rect(renderer, rect);
                                let before_input_camera = camera_state.lock().unwrap().state();
                                renderer.update_manipulator_view(
                                    Some(&selected_id),
                                    manipulator_mode,
                                    manipulator_orientation,
                                    before_input_camera,
                                    camera_settings,
                                    rect,
                                );
                            } else {
                                renderer.clear_manipulator_view();
                            }
                            for input in native_viewport_inputs.drain(..) {
                                let outcome = renderer.handle_manipulator_input(input);
                                if let Some(update) = outcome.update {
                                    if let Err(error) = apply_transform_update(
                                        renderer,
                                        &scene_file_state,
                                        &update.node_id,
                                        update.transform,
                                    ) {
                                        eprintln!(
                                            "native manipulator transform rejected: {}",
                                            diagnostic_text(&error)
                                        );
                                    }
                                }
                                if let Some(rollback) = outcome.rollback {
                                    if let Err(error) = apply_transform_update(
                                        renderer,
                                        &scene_file_state,
                                        &rollback.node_id,
                                        rollback.transform,
                                    ) {
                                        eprintln!(
                                            "native manipulator rollback rejected: {}",
                                            diagnostic_text(&error)
                                        );
                                    }
                                }
                                if let Some(commit) = outcome.commit {
                                    renderer.record_transform_history(
                                        commit.node_id,
                                        commit.before,
                                        commit.after,
                                    );
                                }
                                if !outcome.consumed {
                                    camera_state.lock().unwrap().handle_input(input);
                                }
                            }
                            // PointerUp creates the single history entry for a
                            // whole manipulator gesture. Apply queued Undo/Redo
                            // only after input boundaries from this tick, so a
                            // Ctrl+Z arriving immediately after release cannot
                            // overtake that commit.
                            for request in transform_history_requests.drain(..) {
                                let Some(entry) = renderer.take_transform_history(request) else {
                                    continue;
                                };
                                let target = match request {
                                    TransformHistoryRequest::Undo => entry.before.clone(),
                                    TransformHistoryRequest::Redo => entry.after.clone(),
                                };
                                match apply_transform_update(
                                    renderer,
                                    &scene_file_state,
                                    &entry.node_id,
                                    target,
                                ) {
                                    Ok(()) => renderer.finish_transform_history(request),
                                    Err(error) => eprintln!(
                                        "transform history request rejected: {}",
                                        diagnostic_text(&error)
                                    ),
                                }
                            }
                            let camera = camera_state.lock().unwrap().state();
                            native_render_active = native_tick_should_render(
                                native_render_active,
                                lifecycle_store.is_active(),
                            );
                            if native_render_active {
                                renderer.set_camera_state(camera);
                                renderer.set_camera_settings(camera_settings);
                                if let Some(rect) = viewport_rect {
                                    renderer.update_manipulator_view(
                                        Some(&selected_id),
                                        manipulator_mode,
                                        manipulator_orientation,
                                        camera,
                                        camera_settings,
                                        rect,
                                    );
                                }
                                renderer.set_viewport_display(viewport_display);
                                renderer.set_viewport_lighting(viewport_lighting);
                                if let Some((revision, settings, encoded)) =
                                    viewport_environment
                                {
                                    if renderer.set_viewport_environment(
                                        settings,
                                        encoded.as_deref().map(Vec::as_slice),
                                    ) {
                                        last_viewport_environment_revision = revision;
                                    }
                                }
                                // An uncaptured device error can transition the
                                // lifecycle from another thread while the
                                // setters above are running. Never submit the
                                // next frame after observing that transition.
                                native_render_active = native_tick_should_render(
                                    native_render_active,
                                    lifecycle_store.is_active(),
                                );
                                if native_render_active {
                                    let frame_status = renderer.render();
                                    if let Some(reason) =
                                        renderer_status::frame_fallback_reason(frame_status)
                                    {
                                        if let Some(status) =
                                            lifecycle_store.mark_unavailable_once(reason)
                                        {
                                            if let Err(error) = app_handle
                                                .emit("renderer-status-changed", status)
                                            {
                                                eprintln!(
                                                    "failed to emit renderer status after SurfaceUnavailable: {error}"
                                                );
                                            }
                                        }
                                    }
                                    native_render_active = native_tick_should_render(
                                        native_render_active,
                                        lifecycle_store.is_active(),
                                    );
                                }
                            }
                        }
                        // Inspector edits can also populate this history while
                        // Native is inactive. The active path above normally
                        // drains requests after its input queue; this fallback
                        // preserves Undo/Redo for non-viewport edits.
                        for request in transform_history_requests.drain(..) {
                            let Some(entry) = renderer.take_transform_history(request) else {
                                continue;
                            };
                            let target = match request {
                                TransformHistoryRequest::Undo => entry.before.clone(),
                                TransformHistoryRequest::Redo => entry.after.clone(),
                            };
                            match apply_transform_update(
                                renderer,
                                &scene_file_state,
                                &entry.node_id,
                                target,
                            ) {
                                Ok(()) => renderer.finish_transform_history(request),
                                Err(error) => eprintln!(
                                    "transform history request rejected: {}",
                                    diagnostic_text(&error)
                                ),
                            }
                        }
                        if !native_render_active {
                            // Keep the projection/timeline path below alive
                            // for acknowledgements and the unavailable event,
                            // while ensuring no stale drag survives the fence.
                            native_viewport_inputs.clear();
                            cancel_native_drag(renderer, &scene_file_state, &camera_state);
                        }
                        if scene_projection_publish_due(
                            native_render_active,
                            last_scene_projection_publish.elapsed(),
                            has_scene_work,
                        ) {
                            projection_store
                                .publish(renderer.scene_projection(Some(&selected_id)));
                            last_scene_projection_publish = Instant::now();
                        }
                        let timeline_event_poll_due = if native_render_active {
                            let changed = playback_store.publish(renderer.timeline_playback_snapshot());
                            changed
                                || playback_store.has_pending_unavailable_event()
                                || playback_store.has_pending_semantic_event()
                        } else {
                            playback_store.publish_unavailable_if_needed()
                        };
                        if timeline_event_poll_due {
                            if let Some(snapshot) = playback_store.take_event_snapshot(250) {
                                if let Err(error) =
                                    app_handle.emit("timeline-playback-changed", snapshot)
                                {
                                    eprintln!(
                                        "failed to emit timeline playback snapshot: {error}"
                                    );
                                }
                            }
                        }
                    } else {
                        // Preserve the previous fail-closed behavior: input
                        // queued while Native is unavailable is discarded.
                        native_viewport_inputs.clear();
                        for envelope in playback_commands.take().unwrap_or_default() {
                            let error = "Native renderer is unavailable".to_string();
                            eprintln!("timeline playback command rejected: {error}");
                            playback_store.record_command_result(&envelope, Err(error));
                        }
                        if playback_store.publish_unavailable_if_needed() {
                            if let Some(snapshot) = playback_store.take_event_snapshot(250) {
                                if let Err(error) =
                                    app_handle.emit("timeline-playback-changed", snapshot)
                                {
                                    eprintln!(
                                        "failed to emit timeline playback snapshot: {error}"
                                    );
                                }
                            }
                        }
                    }
                });
            }
            _ => {}
        });
}

#[cfg(test)]
mod viewport_environment_tests {
    use super::*;

    fn settings() -> ViewportEnvironmentSettings {
        ViewportEnvironmentSettings {
            enabled: true,
            path: std::env::current_dir()
                .unwrap()
                .join("studio.hdr")
                .to_string_lossy()
                .into_owned(),
            rotation_degrees: 90.0,
            intensity: 1.5,
        }
    }

    #[test]
    fn validates_supported_environment_ranges() {
        assert!(validate_viewport_environment(&settings()).is_ok());
    }

    #[test]
    fn environment_sequence_rejects_unsafe_values_without_poisoning_follow_up() {
        let mut control = ViewportEnvironmentControl::default();
        accept_viewport_environment_sequence(&mut control, MAX_JS_SAFE_INTEGER).unwrap();
        let error = accept_viewport_environment_sequence(&mut control, MAX_JS_SAFE_INTEGER + 1)
            .expect_err("unsafe sequence must be rejected");
        assert!(error.contains("safe integer"));
        assert_eq!(control.latest_sequence, MAX_JS_SAFE_INTEGER);
        let error = accept_viewport_environment_sequence(&mut control, 1)
            .expect_err("older sequence should remain superseded");
        assert!(error.contains("superseded"));

        let mut control = ViewportEnvironmentControl::default();
        assert!(accept_viewport_environment_sequence(&mut control, 1).is_ok());
        let error = accept_viewport_environment_sequence(&mut control, u64::MAX)
            .expect_err("u64::MAX must be rejected");
        assert!(error.contains("safe integer"));
        assert_eq!(control.latest_sequence, 1);
        assert!(accept_viewport_environment_sequence(&mut control, 2).is_ok());
    }

    #[test]
    fn rejects_relative_enabled_path() {
        let mut value = settings();
        value.path = "studio.hdr".into();
        assert!(validate_viewport_environment(&value)
            .unwrap_err()
            .contains("absolute"));
    }

    #[test]
    fn rejects_oversized_hdri_path_before_snapshot_clone() {
        let mut value = settings();
        value.path = "C:\\".to_string() + &"x".repeat(MAX_VIEWPORT_ENVIRONMENT_PATH_BYTES);
        let error = validate_viewport_environment(&value).unwrap_err();
        assert!(error.contains("path") && error.contains("limit"));
    }

    #[test]
    fn rejects_non_finite_or_out_of_range_controls() {
        let mut value = settings();
        value.rotation_degrees = f32::NAN;
        assert!(validate_viewport_environment(&value).is_err());
        value.rotation_degrees = 0.0;
        value.intensity = 8.1;
        assert!(validate_viewport_environment(&value).is_err());
    }

    #[test]
    fn invalid_environment_payload_does_not_consume_sequence() {
        let mut value = settings();
        value.intensity = f32::NAN;
        let mut control = ViewportEnvironmentControl::default();

        assert!(validate_viewport_environment(&value).is_err());
        assert_eq!(control.latest_sequence, 0);
        assert!(accept_viewport_environment_sequence(&mut control, 1).is_ok());
    }

    #[test]
    fn rejects_encoded_hdri_above_file_size_limit() {
        assert!(
            validate_viewport_environment_encoded_size(MAX_VIEWPORT_ENVIRONMENT_ENCODED_BYTES)
                .is_ok()
        );
        assert!(validate_viewport_environment_encoded_size(
            MAX_VIEWPORT_ENVIRONMENT_ENCODED_BYTES + 1
        )
        .unwrap_err()
        .contains("encoded size limit"));
    }

    #[test]
    fn bounded_file_read_stops_after_limit_plus_one_byte() {
        let root = std::env::temp_dir().join(format!(
            "tauri3d-bounded-file-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("payload.bin");
        std::fs::write(&path, b"0123456789").expect("write payload");
        let bytes = read_bounded_file(&path, 4).expect("bounded read");
        assert_eq!(bytes, b"01234");
        std::fs::remove_dir_all(root).expect("remove temp directory");
    }
}

#[cfg(test)]
mod viewport_input_queue_tests {
    use super::*;

    fn pointer_move(x: f32) -> ViewportInput {
        ViewportInput::PointerMove {
            x,
            y: 0.0,
            buttons: 1,
            modifiers: 0,
        }
    }

    #[test]
    fn coalesces_adjacent_moves_and_caps_move_only_queue() {
        let mut queue = VecDeque::new();
        enqueue_viewport_input(&mut queue, pointer_move(1.0)).unwrap();
        enqueue_viewport_input(&mut queue, pointer_move(2.0)).unwrap();
        assert_eq!(queue.len(), 1);
        assert!(matches!(queue.front(), Some(ViewportInput::PointerMove { x, .. }) if *x == 2.0));

        for index in 0..MAX_VIEWPORT_INPUT_QUEUE {
            enqueue_viewport_input(
                &mut queue,
                ViewportInput::Wheel {
                    dx: index as f32,
                    dy: 0.0,
                    modifiers: 0,
                },
            )
            .unwrap();
        }
        assert_eq!(queue.len(), MAX_VIEWPORT_INPUT_QUEUE);
        enqueue_viewport_input(&mut queue, pointer_move(3.0)).unwrap();
        assert_eq!(queue.len(), MAX_VIEWPORT_INPUT_QUEUE);
        assert_eq!(
            queue
                .iter()
                .filter(|input| matches!(input, ViewportInput::PointerMove { .. }))
                .count(),
            0
        );
    }

    #[test]
    fn boundary_evicts_old_move_but_rejects_when_only_boundaries_remain() {
        let mut queue = VecDeque::new();
        for index in 0..(MAX_VIEWPORT_INPUT_QUEUE - 1) {
            queue.push_back(ViewportInput::Wheel {
                dx: index as f32,
                dy: 0.0,
                modifiers: 0,
            });
        }
        queue.push_back(pointer_move(1.0));
        enqueue_viewport_input(
            &mut queue,
            ViewportInput::PointerUp {
                x: 0.0,
                y: 0.0,
                button: 0,
                modifiers: 0,
            },
        )
        .unwrap();
        assert_eq!(queue.len(), MAX_VIEWPORT_INPUT_QUEUE);
        assert!(queue
            .iter()
            .all(|input| !matches!(input, ViewportInput::PointerMove { .. })));

        let error = enqueue_viewport_input(&mut queue, ViewportInput::PointerCancel)
            .expect_err("boundary must not be silently dropped");
        assert!(error.contains("queue is full"));
    }
}

#[cfg(test)]
mod viewport_lighting_tests {
    use super::*;

    #[test]
    fn accepts_default_lighting_and_supported_resolutions() {
        let mut value = ViewportLightingSettings::default();
        assert!(validate_viewport_lighting(&value).is_ok());
        for resolution in [512, 1024, 2048] {
            value.shadow_resolution = resolution;
            assert!(validate_viewport_lighting(&value).is_ok());
        }
    }

    #[test]
    fn rejects_invalid_lighting_ranges() {
        let value = ViewportLightingSettings {
            exposure: f32::NAN,
            ..ViewportLightingSettings::default()
        };
        assert!(validate_viewport_lighting(&value).is_err());
        let value = ViewportLightingSettings {
            shadow_resolution: 4096,
            ..ViewportLightingSettings::default()
        };
        assert!(validate_viewport_lighting(&value).is_err());
        let value = ViewportLightingSettings {
            background_color: [2.0, 0.0, 0.0],
            ..ViewportLightingSettings::default()
        };
        assert!(validate_viewport_lighting(&value).is_err());
    }
}

#[cfg(test)]
mod camera_state_tests {
    use super::*;

    fn camera_state() -> CameraState {
        CameraState {
            target: [1.0, -2.0, 3.0],
            yaw: -0.6,
            pitch: 0.35,
            distance: 4.0,
        }
    }

    #[test]
    fn accepts_finite_camera_with_positive_distance() {
        assert!(validate_camera_state(&camera_state()).is_ok());
    }

    #[test]
    fn rejects_non_finite_camera_components() {
        for camera in [
            CameraState {
                target: [f32::NAN, 0.0, 0.0],
                ..camera_state()
            },
            CameraState {
                yaw: f32::INFINITY,
                ..camera_state()
            },
            CameraState {
                pitch: f32::NEG_INFINITY,
                ..camera_state()
            },
            CameraState {
                distance: f32::NAN,
                ..camera_state()
            },
        ] {
            assert!(validate_camera_state(&camera).is_err());
        }
    }

    #[test]
    fn rejects_non_positive_distance() {
        for distance in [0.0, -1.0] {
            let camera = CameraState {
                distance,
                ..camera_state()
            };
            assert!(validate_camera_state(&camera).is_err());
        }
    }
}

#[cfg(test)]
mod native_render_lifecycle_tests {
    use super::*;

    #[test]
    fn stale_active_snapshot_cannot_render_after_lifecycle_deactivation() {
        assert!(native_tick_should_render(true, true));
        assert!(!native_tick_should_render(true, false));
        assert!(!native_tick_should_render(false, true));
    }

    #[test]
    fn wake_cadence_slows_only_when_native_is_inactive() {
        assert_eq!(native_wake_interval(true), Duration::from_millis(16));
        assert_eq!(native_wake_interval(false), Duration::from_millis(100));
    }
}

#[cfg(test)]
mod performance_summary_tests {
    use super::*;

    #[test]
    fn performance_summary_accepts_bounded_payload() {
        assert!(report_performance_summary(serde_json::json!({
            "fps": 60.0,
            "frameMs": 16.7,
        }))
        .is_ok());
    }

    #[test]
    fn performance_summary_rejects_oversized_payload() {
        let error = report_performance_summary(serde_json::Value::String(
            "x".repeat(MAX_PERFORMANCE_SUMMARY_BYTES),
        ))
        .expect_err("performance summaries must be bounded");
        assert!(error.contains("performance summary"));
    }

    #[test]
    fn performance_summary_diagnostic_uses_bounded_single_line_text() {
        let summary = serde_json::json!({"message": "line\nwith\tcontrol"});
        let rendered = diagnostic_text(&summary.to_string());
        assert!(!rendered.contains('\n'));
        assert!(rendered.contains("\\n"));
        assert!(rendered.contains("\\t"));
    }
}

#[cfg(test)]
mod scene_projection_cadence_tests {
    use super::*;

    #[test]
    fn publishes_only_at_or_after_the_100ms_cadence() {
        assert!(!scene_projection_cadence_due(Duration::from_millis(99)));
        assert!(scene_projection_cadence_due(Duration::from_millis(100)));
        assert!(scene_projection_cadence_due(Duration::from_millis(101)));
    }

    #[test]
    fn active_projection_keeps_the_cadence_while_inactive_requires_work() {
        assert!(!scene_projection_publish_due(
            true,
            Duration::from_millis(99),
            false,
        ));
        assert!(scene_projection_publish_due(
            true,
            Duration::from_millis(100),
            false,
        ));
        assert!(!scene_projection_publish_due(
            false,
            Duration::from_secs(10),
            false,
        ));
        assert!(scene_projection_publish_due(
            false,
            Duration::from_millis(1),
            true,
        ));
    }
}
