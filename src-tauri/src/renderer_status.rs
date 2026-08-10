use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use kiss3d::prelude::{RenderFrameStatus, SurfaceSkipReason, SurfaceUnavailableReason};

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererStatus {
    pub native_available: bool,
    pub native_active: bool,
    pub fallback_reason: Option<String>,
    pub recovery_hint: Option<String>,
}

impl RendererStatus {
    pub fn available() -> Self {
        Self {
            native_available: true,
            native_active: true,
            fallback_reason: None,
            recovery_hint: None,
        }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self::unavailable_with_hint(reason, "Restart the application to retry Native wgpu")
    }

    pub fn unavailable_with_hint(
        reason: impl Into<String>,
        recovery_hint: impl Into<String>,
    ) -> Self {
        Self {
            native_available: false,
            native_active: false,
            fallback_reason: Some(reason.into()),
            recovery_hint: Some(recovery_hint.into()),
        }
    }
}

pub struct RendererStatusStore {
    status: Mutex<RendererStatus>,
    /// Render-loop fast path. Every write occurs while `status` is locked so
    /// an unavailable wire snapshot can never coexist with an active bit.
    active: AtomicBool,
}

impl RendererStatusStore {
    pub fn new(status: RendererStatus) -> Self {
        let store = Self {
            status: Mutex::new(status),
            active: AtomicBool::new(false),
        };
        let active = store.status.lock().unwrap().native_active;
        store.active.store(active, Ordering::Release);
        store
    }

    pub fn status(&self) -> RendererStatus {
        self.status.lock().unwrap().clone()
    }

    /// Lock-free render-loop read. Mutations are serialized with the status
    /// mutex; Acquire pairs with the Release stores below.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn set_active(&self, active: bool) -> Result<RendererStatus, String> {
        let mut status = self.status.lock().unwrap();
        if active && !status.native_available {
            return Err(status
                .fallback_reason
                .clone()
                .unwrap_or_else(|| "Native renderer is unavailable".into()));
        }
        status.native_active = active;
        self.active.store(active, Ordering::Release);
        Ok(status.clone())
    }

    /// Marks Native unavailable once. Repeated frame statuses do not produce
    /// duplicate state transitions or frontend events.
    pub fn mark_unavailable_once(&self, reason: impl Into<String>) -> Option<RendererStatus> {
        let mut status = self.status.lock().unwrap();
        if !status.native_available && !status.native_active {
            return None;
        }
        // Clear the hot path before publishing the unavailable snapshot. A
        // concurrent render read can therefore only observe `false` while the
        // mutex-protected status transitions to unavailable.
        self.active.store(false, Ordering::Release);
        *status = RendererStatus::unavailable(reason);
        Some(status.clone())
    }
}

/// Returns a stable fallback reason only for fatal Native surface outcomes.
/// Surface skips and Closed remain non-fatal to the renderer lifecycle.
pub fn frame_fallback_reason(status: RenderFrameStatus) -> Option<&'static str> {
    match status {
        RenderFrameStatus::SurfaceUnavailable(SurfaceUnavailableReason::Lost) => {
            Some("Native surface unavailable: Lost")
        }
        RenderFrameStatus::SurfaceUnavailable(SurfaceUnavailableReason::Validation) => {
            Some("Native surface unavailable: Validation")
        }
        RenderFrameStatus::SurfaceUnavailable(SurfaceUnavailableReason::MissingSurface) => {
            Some("Native surface unavailable: MissingSurface")
        }
        RenderFrameStatus::Presented { .. }
        | RenderFrameStatus::Skipped(SurfaceSkipReason::Timeout)
        | RenderFrameStatus::Skipped(SurfaceSkipReason::Occluded)
        | RenderFrameStatus::Skipped(SurfaceSkipReason::OutdatedAfterReconfigure)
        | RenderFrameStatus::Skipped(SurfaceSkipReason::ZeroSizedSurface)
        | RenderFrameStatus::Closed => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_renderer_rejects_reactivation_and_keeps_reason() {
        let store = RendererStatusStore::new(RendererStatus::unavailable("injected failure"));

        let error = store.set_active(true).expect_err("reactivation must fail");

        assert_eq!(error, "injected failure");
        let status = store.status();
        assert!(!status.native_available);
        assert!(!status.native_active);
        assert_eq!(status.fallback_reason.as_deref(), Some("injected failure"));
        assert!(status.recovery_hint.is_some());
    }

    #[test]
    fn available_renderer_tracks_manual_backend_switches() {
        let store = RendererStatusStore::new(RendererStatus::available());

        assert!(!store.set_active(false).unwrap().native_active);
        assert!(store.set_active(true).unwrap().native_active);
    }

    #[test]
    fn runtime_failure_replaces_active_status_fail_closed() {
        let store = RendererStatusStore::new(RendererStatus::available());

        let status = store
            .mark_unavailable_once("wgpu device lost")
            .expect("first runtime failure must transition");

        assert!(!status.native_available);
        assert!(!status.native_active);
        assert_eq!(status.fallback_reason.as_deref(), Some("wgpu device lost"));
        assert!(store.set_active(true).is_err());
    }

    #[test]
    fn only_unavailable_surface_statuses_request_fallback() {
        assert_eq!(
            frame_fallback_reason(RenderFrameStatus::Presented { suboptimal: false }),
            None
        );
        for reason in [
            SurfaceSkipReason::Timeout,
            SurfaceSkipReason::Occluded,
            SurfaceSkipReason::OutdatedAfterReconfigure,
            SurfaceSkipReason::ZeroSizedSurface,
        ] {
            assert_eq!(
                frame_fallback_reason(RenderFrameStatus::Skipped(reason)),
                None
            );
        }
        assert_eq!(frame_fallback_reason(RenderFrameStatus::Closed), None);
        assert_eq!(
            frame_fallback_reason(RenderFrameStatus::SurfaceUnavailable(
                SurfaceUnavailableReason::Lost,
            )),
            Some("Native surface unavailable: Lost")
        );
        assert_eq!(
            frame_fallback_reason(RenderFrameStatus::SurfaceUnavailable(
                SurfaceUnavailableReason::Validation,
            )),
            Some("Native surface unavailable: Validation")
        );
        assert_eq!(
            frame_fallback_reason(RenderFrameStatus::SurfaceUnavailable(
                SurfaceUnavailableReason::MissingSurface,
            )),
            Some("Native surface unavailable: MissingSurface")
        );
    }

    #[test]
    fn unavailable_transition_is_one_shot() {
        let store = RendererStatusStore::new(RendererStatus::available());
        assert!(store
            .mark_unavailable_once("Native surface unavailable: Lost")
            .is_some());
        assert!(store
            .mark_unavailable_once("Native surface unavailable: Lost")
            .is_none());
    }

    #[test]
    fn active_fast_path_matches_each_lifecycle_snapshot() {
        let store = RendererStatusStore::new(RendererStatus::available());
        assert!(store.status().native_available);
        assert!(store.is_active());

        let inactive = store.set_active(false).unwrap();
        assert!(!inactive.native_active);
        assert!(!store.is_active());

        let active = store.set_active(true).unwrap();
        assert!(active.native_active);
        assert!(store.is_active());

        let unavailable = store
            .mark_unavailable_once("surface lost")
            .expect("first unavailable transition");
        assert!(!unavailable.native_available);
        assert!(!unavailable.native_active);
        assert!(!store.is_active());
        assert!(!store.status().native_available || !store.is_active());
    }
}
