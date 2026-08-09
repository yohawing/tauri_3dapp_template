use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePlaybackSnapshot {
    pub revision: u64,
    pub sampled_at_unix_ms: u64,
    pub available: bool,
    pub instance_id: Option<String>,
    pub clip_index: Option<usize>,
    pub time: f32,
    pub duration: f32,
    pub playing: bool,
    pub looping: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TimelinePlaybackCommand {
    Play {
        instance_id: String,
        clip_index: usize,
    },
    Pause {
        instance_id: String,
        clip_index: usize,
    },
    Seek {
        instance_id: String,
        clip_index: usize,
        time: f32,
    },
    SetLooping {
        instance_id: String,
        clip_index: usize,
        looping: bool,
    },
}

impl TimelinePlaybackCommand {
    pub fn validate(&self) -> Result<(), String> {
        let (instance_id, time) = match self {
            Self::Play { instance_id, .. }
            | Self::Pause { instance_id, .. }
            | Self::SetLooping { instance_id, .. } => (instance_id, None),
            Self::Seek {
                instance_id, time, ..
            } => (instance_id, Some(*time)),
        };
        if instance_id.trim().is_empty() {
            return Err("timeline playback instanceId must not be empty".to_string());
        }
        if time.is_some_and(|value| !value.is_finite() || value < 0.0) {
            return Err("timeline playback time must be finite and non-negative".to_string());
        }
        Ok(())
    }

    pub fn target(&self) -> (&str, usize) {
        match self {
            Self::Play {
                instance_id,
                clip_index,
            }
            | Self::Pause {
                instance_id,
                clip_index,
            }
            | Self::Seek {
                instance_id,
                clip_index,
                ..
            }
            | Self::SetLooping {
                instance_id,
                clip_index,
                ..
            } => (instance_id, *clip_index),
        }
    }
}

#[derive(Default)]
pub struct TimelinePlaybackStore {
    pending: Mutex<VecDeque<TimelinePlaybackCommand>>,
    snapshot: Mutex<TimelinePlaybackSnapshot>,
    last_event_at: Mutex<Option<Instant>>,
    last_event_target: Mutex<Option<(bool, Option<String>, Option<usize>)>>,
}

impl TimelinePlaybackStore {
    pub fn request(&self, command: TimelinePlaybackCommand) -> Result<(), String> {
        command.validate()?;
        self.pending.lock().unwrap().push_back(command);
        Ok(())
    }

    pub fn take_commands(&self) -> Vec<TimelinePlaybackCommand> {
        self.pending.lock().unwrap().drain(..).collect()
    }

    pub fn publish(&self, mut snapshot: TimelinePlaybackSnapshot) {
        let mut current = self.snapshot.lock().unwrap();
        snapshot.revision = current.revision.saturating_add(1);
        snapshot.sampled_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        *current = snapshot;
    }

    pub fn snapshot(&self) -> TimelinePlaybackSnapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn take_event_snapshot(
        &self,
        minimum_interval_ms: u64,
    ) -> Option<TimelinePlaybackSnapshot> {
        let snapshot = self.snapshot();
        let now = Instant::now();
        let target = (
            snapshot.available,
            snapshot.instance_id.clone(),
            snapshot.clip_index,
        );
        let mut last_target = self.last_event_target.lock().unwrap();
        let target_changed = last_target.as_ref() != Some(&target);
        if !snapshot.available && !target_changed {
            return None;
        }
        let mut last_event = self.last_event_at.lock().unwrap();
        if !target_changed
            && last_event.is_some_and(|previous| {
                now.duration_since(previous) < Duration::from_millis(minimum_interval_ms)
            })
        {
            return None;
        }
        *last_event = Some(now);
        *last_target = Some(target);
        Some(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_seek_and_preserves_command_order() {
        let store = TimelinePlaybackStore::default();
        assert!(store
            .request(TimelinePlaybackCommand::Seek {
                instance_id: "model".to_string(),
                clip_index: 0,
                time: f32::NAN,
            })
            .is_err());
        let play = TimelinePlaybackCommand::Play {
            instance_id: "model".to_string(),
            clip_index: 0,
        };
        let pause = TimelinePlaybackCommand::Pause {
            instance_id: "model".to_string(),
            clip_index: 0,
        };
        store.request(play.clone()).unwrap();
        store.request(pause.clone()).unwrap();
        assert_eq!(store.take_commands(), vec![play, pause]);
    }

    #[test]
    fn publish_advances_revision() {
        let store = TimelinePlaybackStore::default();
        store.publish(TimelinePlaybackSnapshot {
            available: true,
            ..Default::default()
        });
        assert_eq!(store.snapshot().revision, 1);
        assert!(store.snapshot().sampled_at_unix_ms > 0);
        assert!(store.snapshot().available);
    }

    #[test]
    fn command_deserializes_typescript_wire_shape() {
        let command: TimelinePlaybackCommand = serde_json::from_str(
            r#"{"type":"seek","instanceId":"model","clipIndex":2,"time":1.25}"#,
        )
        .unwrap();
        assert_eq!(
            command,
            TimelinePlaybackCommand::Seek {
                instance_id: "model".to_string(),
                clip_index: 2,
                time: 1.25,
            }
        );
    }

    #[test]
    fn event_snapshot_is_throttled_by_sample_timestamp() {
        let store = TimelinePlaybackStore::default();
        store.publish(TimelinePlaybackSnapshot::default());
        assert!(store.take_event_snapshot(250).is_some());
        assert!(store.take_event_snapshot(250).is_none());
    }

    #[test]
    fn unavailable_snapshot_is_only_emitted_on_target_transition() {
        let store = TimelinePlaybackStore::default();
        store.publish(TimelinePlaybackSnapshot::default());
        assert!(store.take_event_snapshot(0).is_some());
        store.publish(TimelinePlaybackSnapshot::default());
        assert!(store.take_event_snapshot(0).is_none());

        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            ..Default::default()
        });
        assert!(store.take_event_snapshot(250).is_some());
        store.publish(TimelinePlaybackSnapshot::default());
        assert!(store.take_event_snapshot(250).is_some());
    }
}
