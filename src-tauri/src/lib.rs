mod camera;
mod protocol;
mod renderer;

use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

use camera::OrbitCamera;
use protocol::{ViewportInput, ViewportRect};
use renderer::Renderer;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn set_viewport_rect(state: tauri::State<Mutex<Renderer>>, rect: ViewportRect) {
    let mut renderer = state.lock().unwrap();
    renderer::apply_viewport_rect(&mut renderer, rect);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            set_viewport_rect,
            viewport_input
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("no main window");
            let size = window.inner_size()?;

            let renderer = Renderer::new(window, (size.width, size.height));
            app.manage(Mutex::new(renderer));
            app.manage(Mutex::new(OrbitCamera::default()));

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
                let state = app_handle.state::<Mutex<Renderer>>();
                let mut renderer = state.lock().unwrap();
                renderer.resize(size.width, size.height);
            }
            RunEvent::MainEventsCleared => {
                let renderer_state = app_handle.state::<Mutex<Renderer>>();
                let camera_state = app_handle.state::<Mutex<OrbitCamera>>();

                // Aspect ratio comes from the CURRENT viewport rect (the
                // region the cube actually draws into), not the full window.
                let aspect = renderer_state.lock().unwrap().viewport_aspect();
                let view_proj = camera_state.lock().unwrap().view_proj(aspect);

                let mut renderer = renderer_state.lock().unwrap();
                renderer.set_view_proj(view_proj);
                renderer.render();
            }
            _ => {}
        });
}
