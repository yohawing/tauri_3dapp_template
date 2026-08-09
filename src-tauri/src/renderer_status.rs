use std::sync::Mutex;

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

pub struct RendererStatusStore(Mutex<RendererStatus>);

impl RendererStatusStore {
    pub fn new(status: RendererStatus) -> Self {
        Self(Mutex::new(status))
    }

    pub fn status(&self) -> RendererStatus {
        self.0.lock().unwrap().clone()
    }

    pub fn set_active(&self, active: bool) -> Result<RendererStatus, String> {
        let mut status = self.0.lock().unwrap();
        if active && !status.native_available {
            return Err(status
                .fallback_reason
                .clone()
                .unwrap_or_else(|| "Native renderer is unavailable".into()));
        }
        status.native_active = active;
        Ok(status.clone())
    }

    pub fn mark_unavailable(&self, reason: impl Into<String>) -> RendererStatus {
        let mut status = self.0.lock().unwrap();
        *status = RendererStatus::unavailable(reason);
        status.clone()
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

        let status = store.mark_unavailable("wgpu device lost");

        assert!(!status.native_available);
        assert!(!status.native_active);
        assert_eq!(status.fallback_reason.as_deref(), Some("wgpu device lost"));
        assert!(store.set_active(true).is_err());
    }
}
