mod camera;
mod protocol;
mod renderer;
pub mod scene;
mod scene_projection;
mod timeline;

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{Manager, RunEvent, WindowEvent};

use camera::OrbitCamera;
use protocol::{CameraState, ViewportInput, ViewportRect};
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
fn set_renderer_active(state: tauri::State<RendererActive>, active: bool) {
    state.0.store(active, Ordering::Relaxed);
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
    state: tauri::State<timeline::TimelineProjection>,
) -> timeline::TimelineProjection {
    state.inner().clone()
}

fn scene_camera_state(document: &scene::Scene) -> Result<CameraState, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            set_viewport_rect,
            viewport_input,
            set_renderer_active,
            get_camera,
            set_camera,
            get_scene_projection,
            select_scene_node,
            dispatch_scene_command,
            get_timeline_projection
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("no main window");
            let size = window.inner_size()?;

            let configured_scene = std::env::var_os("TAURI3D_SCENE");
            let (renderer, initial_camera, timeline_projection) = match configured_scene {
                None => {
                    let renderer = Renderer::new(window, (size.width, size.height));
                    (
                        renderer,
                        OrbitCamera::default().state(),
                        timeline::TimelineProjection::default(),
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
                    let initial_camera = scene_camera_state(&document).map_err(|error| {
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
                    (renderer, initial_camera, timeline_projection)
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
            NATIVE_RENDERER.with(|slot| {
                *slot.borrow_mut() = Some(renderer);
            });
            let mut camera = OrbitCamera::default();
            camera.set_state(initial_camera);
            app.manage(Mutex::new(camera));
            app.manage(RendererActive(AtomicBool::new(true)));
            app.manage(RendererControl::default());
            app.manage(ViewportRectLog::default());
            app.manage(projection_store);
            app.manage(timeline_projection);

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
                let active = app_handle
                    .state::<RendererActive>()
                    .0
                    .load(Ordering::Relaxed);
                let projection_store = app_handle.state::<SceneProjectionStore>();
                let commands = projection_store.take_commands();
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
                            renderer.render();
                        }
                        projection_store.publish(renderer.scene_projection(Some(&selected_id)));
                    }
                });
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{Scene, SceneCamera};

    fn document(camera: SceneCamera) -> Scene {
        Scene {
            version: 1,
            name: None,
            assets: Vec::new(),
            instances: Vec::new(),
            camera: Some(camera),
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
}
