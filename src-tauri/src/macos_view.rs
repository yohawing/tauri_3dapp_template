use std::ffi::c_void;
use std::ptr::NonNull;

use objc2_app_kit::{NSView, NSWindow};
use wgpu::rwh::{
    AppKitWindowHandle, DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle,
    RawWindowHandle, WindowHandle,
};

fn with_content_view<T>(
    window: &tauri::WebviewWindow,
    operation: impl FnOnce(&NSWindow, &NSView) -> T,
) -> Result<T, String> {
    let ns_window = window
        .ns_window()
        .map_err(|error| format!("failed to read NSWindow: {error}"))?;
    let ns_window = NonNull::new(ns_window).ok_or("Tauri returned a null NSWindow pointer")?;
    // SAFETY: Tauri owns the NSWindow and these references do not escape the
    // operation. Callers invoke this through Tauri's AppKit main thread.
    let ns_window: &NSWindow = unsafe { ns_window.cast().as_ref() };
    let content_view = ns_window
        .contentView()
        .ok_or("NSWindow has no content view")?;
    Ok(operation(ns_window, &content_view))
}

pub(crate) fn webview_top_inset(window: &tauri::WebviewWindow) -> Result<f32, String> {
    with_content_view(window, |ns_window, content_view| {
        let frame = content_view.frame();
        let layout = ns_window.contentLayoutRect();
        let inset = frame.origin.y + frame.size.height - (layout.origin.y + layout.size.height);
        inset.max(0.0) as f32
    })
}

/// Wry replaces winit's original content view while constructing WKWebView.
/// Keep the Tauri window alive and expose the current view to wgpu.
pub(crate) struct ContentViewSurfaceTarget {
    _window: tauri::WebviewWindow,
    ns_view: usize,
}

impl ContentViewSurfaceTarget {
    pub(crate) fn new(window: tauri::WebviewWindow) -> Result<Self, String> {
        let ns_view = with_content_view(&window, |_, view| NonNull::from(view).cast::<c_void>())?;
        Ok(Self {
            _window: window,
            ns_view: ns_view.as_ptr() as usize,
        })
    }
}

impl HasWindowHandle for ContentViewSurfaceTarget {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let ns_view = NonNull::new(self.ns_view as *mut c_void)
            .expect("stored NSView pointer must remain non-null");
        let raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(ns_view));
        // SAFETY: `_window` keeps the NSWindow and its content view alive for
        // at least as long as this borrowed handle.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

impl HasDisplayHandle for ContentViewSurfaceTarget {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        Ok(DisplayHandle::appkit())
    }
}
