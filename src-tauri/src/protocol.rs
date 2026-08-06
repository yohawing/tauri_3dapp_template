//! IPC data-transfer objects shared between the WebView and Rust.
//!
//! Kept dependency-free (serde only, no wgpu/tauri types) so the renderer
//! backend can be swapped without touching the wire format.

/// Rectangle (in CSS pixels, relative to the window's inner viewport) that
/// the frontend wants the native wgpu cube to be drawn into. Fixed IPC
/// contract shared with the web side.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ViewportRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub scale_factor: f32,
}

/// Pointer/wheel input forwarded from the WebView's ViewportHost element via
/// the `viewport_input` command. Generic and extensible: a new input source
/// (keyboard, gamepad, ...) only needs a new variant here plus a match arm
/// in `OrbitCamera::handle_input`.
///
/// `x`/`y` are CSS px in ViewportHost-local coordinates (origin = host
/// top-left). `buttons` is the `PointerEvent.buttons` bitmask (1=left,
/// 4=middle); `button` is `PointerEvent.button` (0=left, 1=middle, 2=right).
/// `modifiers` is a bitfield: 1=Shift, 2=Ctrl, 4=Alt, 8=Meta.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ViewportInput {
    PointerMove {
        x: f32,
        y: f32,
        buttons: u16,
        modifiers: u16,
    },
    PointerDown {
        x: f32,
        y: f32,
        button: u8,
        modifiers: u16,
    },
    PointerUp {
        x: f32,
        y: f32,
        button: u8,
        modifiers: u16,
    },
    Wheel {
        dx: f32,
        dy: f32,
        modifiers: u16,
    },
}
