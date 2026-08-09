mod camera;
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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use camera::OrbitCamera;
use protocol::{
    CameraSettings, CameraState, CameraViewPreset, ViewportDisplayMode, ViewportDisplaySettings,
    ViewportInput, ViewportRect,
};
use renderer::Renderer;
use scene_projection::{SceneCommandEnvelope, SceneCommandResult, SceneProjectionStore};

thread_local! {
    /// Kiss3d uses single-threaded scene graph internals (`Rc`/`RefCell`). Keep
    /// the renderer on Tauri's event-loop thread and share only DTO state with
    /// command handlers.
    static NATIVE_RENDERER: RefCell<Option<Renderer>> = const { RefCell::new(None) };
}

/// Whether the native wgpu renderer should draw this frame. Flipped off when
/// the frontend switches to its Canvas fallback; the surface is still kept
/// reconfigured on resize so reactivation is seamless.
struct RendererActive(AtomicBool);

#[derive(Default)]
struct RendererControl {
    viewport_rect: Mutex<Option<ViewportRect>>,
    viewport_display: Mutex<ViewportDisplaySettings>,
    camera_settings: Mutex<CameraSettings>,
}

/// Diagnostic-only state for `[viewport-rect]` logging (see
/// `set_viewport_rect`). Deliberately kept separate from `Renderer`: by the
/// time a rect reaches `Renderer` it has already been converted from the
/// wire-format CSS-pixel `ViewportRect` into a physical-pixel tuple
/// (`viewport_px`), which is the representation the render loop cares about.
/// The *previous raw `ViewportRect`* (for IPC-level dedup) and a log
/// sequence number are purely a diagnostic concern of this command, not
/// something the renderer needs to know about, so they get their own managed
/// state — the same pattern already used for `RendererActive`.
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

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn set_viewport_rect(
    state: tauri::State<RendererControl>,
    log: tauri::State<ViewportRectLog>,
    rect: ViewportRect,
) {
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
}

#[tauri::command]
fn get_viewport_display(state: tauri::State<RendererControl>) -> ViewportDisplaySettings {
    *state.viewport_display.lock().unwrap()
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

/// Generic input entry point for the ViewportHost: pointer/wheel events are
/// forwarded here as a tagged `ViewportInput` and applied to the orbit
/// camera. Adding a new input source later only means adding a variant to
/// `ViewportInput` and a match arm in `OrbitCamera::handle_input` — this
/// command and its registration never need to change.
#[tauri::command]
fn viewport_input(state: tauri::State<Mutex<OrbitCamera>>, input: ViewportInput) {
    let mut camera = state.lock().unwrap();
    camera.handle_input(input);
}

/// Toggles the native renderer on/off so the frontend can hand the viewport
/// over to (or reclaim it from) a Canvas fallback. When inactive,
/// `MainEventsCleared` skips rendering entirely; resize still reconfigures
/// the surface so reactivation is clean.
#[tauri::command]
fn set_renderer_active(
    state: tauri::State<RendererActive>,
    status: tauri::State<renderer_status::RendererStatusStore>,
    active: bool,
) -> Result<renderer_status::RendererStatus, String> {
    let next = status.set_active(active)?;
    state.0.store(active, Ordering::Relaxed);
    Ok(next)
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

#[tauri::command]
fn set_camera(state: tauri::State<Mutex<OrbitCamera>>, camera: CameraState) {
    state.lock().unwrap().set_state(camera);
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
fn select_scene_node(state: tauri::State<SceneProjectionStore>, node_id: String) {
    state.request_selection(node_id);
}

#[tauri::command]
fn dispatch_scene_command(
    state: tauri::State<SceneProjectionStore>,
    command: SceneCommandEnvelope,
) -> Result<(), String> {
    state.request_command(command)
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
    command: timeline_playback::TimelinePlaybackCommand,
) -> Result<(), String> {
    state.request(command)
}

#[tauri::command]
fn report_performance_summary(summary: serde_json::Value) {
    eprintln!("[perf] {summary}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            set_viewport_rect,
            get_viewport_display,
            set_viewport_display,
            set_camera_settings,
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
            let window = app.get_webview_window("main").expect("no main window");
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
                    let document = scene::Scene::load(&scene_path).map_err(|error| {
                        format!(
                            "TAURI3D_SCENE '{}' failed before renderer startup: {error}",
                            scene_path.display()
                        )
                    })?;
                    // Scene::load performs the existence check.  Resolve again here to retain
                    // the absolute paths needed by the native runtime builder.
                    let resolved_assets =
                        document.resolve_asset_paths(&scene_path).map_err(|error| {
                            format!(
                                "TAURI3D_SCENE '{}' path resolution failed: {error}",
                                scene_path.display()
                            )
                        })?;
                    let initial_camera = scene_file::scene_camera_state(&document).map_err(|error| {
                        format!(
                            "TAURI3D_SCENE '{}' camera initialization failed: {error}",
                            scene_path.display()
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
                            "TAURI3D_SCENE '{}' native runtime construction failed: {error}",
                            scene_path.display()
                        )
                    })?;
                    let timeline_projection =
                        timeline::load_scene_timeline(&document, &resolved_assets).map_err(
                            |error| {
                                format!(
                                    "TAURI3D_SCENE '{}' animation metadata failed: {error}",
                                    scene_path.display()
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
            // this slot; RendererActive prevents drawing and RendererStatus rejects
            // reactivation until the process is restarted without the fault.
            let initial_playback = renderer.timeline_playback_snapshot();
            NATIVE_RENDERER.with(|slot| {
                *slot.borrow_mut() = Some(renderer);
            });
            let mut camera = OrbitCamera::default();
            camera.set_state(initial_camera);
            app.manage(Mutex::new(camera));
            app.manage(RendererActive(AtomicBool::new(
                renderer_status.native_active,
            )));
            app.manage(renderer_status::RendererStatusStore::new(renderer_status));
            let device = kiss3d::context::Context::get().device;
            let device_lost_handle = app.handle().clone();
            device.set_device_lost_callback(move |reason, message| {
                let detail = if message.is_empty() {
                    format!("wgpu device lost ({reason:?})")
                } else {
                    format!("wgpu device lost ({reason:?}): {message}")
                };
                device_lost_handle
                    .state::<RendererActive>()
                    .0
                    .store(false, Ordering::Relaxed);
                let status = device_lost_handle
                    .state::<renderer_status::RendererStatusStore>()
                    .mark_unavailable(detail);
                if let Err(error) = device_lost_handle.emit("renderer-status-changed", status) {
                    eprintln!("failed to emit renderer status after Device Lost: {error}");
                }
            });
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
            // first frame. Wake the loop ~60 times/sec with a no-op
            // main-thread task; `run_on_main_thread` posts through the tao
            // `EventLoopProxy`, which interrupts `Wait` and drives another
            // `MainEventsCleared` right after.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(16));
                if handle.run_on_main_thread(|| {}).is_err() {
                    break;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
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
            RunEvent::MainEventsCleared => {
                let camera_state = app_handle.state::<Mutex<OrbitCamera>>();
                let camera = camera_state.lock().unwrap().state();
                let viewport_rect = *app_handle
                    .state::<RendererControl>()
                    .viewport_rect
                    .lock()
                    .unwrap();
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
                let active = app_handle
                    .state::<RendererActive>()
                    .0
                    .load(Ordering::Relaxed);
                let projection_store = app_handle.state::<SceneProjectionStore>();
                let playback_store =
                    app_handle.state::<timeline_playback::TimelinePlaybackStore>();
                let commands = projection_store.take_commands();
                let playback_commands = playback_store.take_commands();
                let current_selection = projection_store.projection().selected_node_id;
                let requested_selection = projection_store.take_selection();
                let selected_id = requested_selection.or(current_selection);

                NATIVE_RENDERER.with(|slot| {
                    if let Some(renderer) = slot.borrow_mut().as_mut() {
                        for envelope in commands {
                            let node_id = envelope.command.node_id().to_string();
                            let property = envelope.command.property().to_string();
                            let sequence = envelope.sequence;
                            let result = renderer.apply_scene_command(envelope.command);
                            projection_store.record_command_result(SceneCommandResult {
                                sequence,
                                node_id,
                                property,
                                applied: result.is_ok(),
                                error: result.err(),
                            });
                        }
                        for command in playback_commands {
                            if let Err(error) = renderer.apply_timeline_playback_command(command) {
                                eprintln!("timeline playback command rejected: {error}");
                            }
                        }
                        let selected_id = selected_id
                            .as_deref()
                            .filter(|id| renderer.has_node(id))
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| renderer.default_node_id().to_string());
                        if active {
                            if let Some(rect) = viewport_rect {
                                renderer::apply_viewport_rect(renderer, rect);
                            }
                            renderer.set_camera_state(camera);
                            renderer.set_camera_settings(camera_settings);
                            renderer.set_viewport_display(viewport_display);
                            renderer.render();
                        }
                        projection_store.publish(renderer.scene_projection(Some(&selected_id)));
                        playback_store.publish(renderer.timeline_playback_snapshot());
                        if let Some(snapshot) = playback_store.take_event_snapshot(250) {
                            if let Err(error) = app_handle.emit("timeline-playback-changed", snapshot)
                            {
                                eprintln!("failed to emit timeline playback snapshot: {error}");
                            }
                        }
                    }
                });
            }
            _ => {}
        });
}
