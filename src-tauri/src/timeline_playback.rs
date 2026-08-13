use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::scene::diagnostic_text;

const MAX_RUNTIME_ID_BYTES: usize = 1024;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_REQUEST_ID: u64 = MAX_JS_SAFE_INTEGER;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePlaybackSnapshot {
    /// Runtime Scene generation. Commands and snapshots from an older Scene
    /// must not cross a replacement boundary, even when instance IDs repeat.
    pub epoch: u64,
    pub revision: u64,
    pub sampled_at_unix_ms: u64,
    /// Wall-clock timestamp captured immediately before the snapshot is emitted to WebView.
    /// This is zero for snapshots returned by `get_timeline_playback` that have not gone
    /// through the throttled event path yet.
    pub emitted_at_unix_ms: u64,
    /// Monotonic, process-local sequence for emitted timeline events.
    /// It intentionally is not persisted in Scene camera/animation state.
    pub event_sequence: u64,
    pub available: bool,
    pub instance_id: Option<String>,
    pub clip_index: Option<usize>,
    pub time: f32,
    pub duration: f32,
    pub playing: bool,
    pub looping: bool,
    pub command_results: Vec<TimelinePlaybackCommandResult>,
}

impl Default for TimelinePlaybackSnapshot {
    fn default() -> Self {
        Self {
            epoch: 1,
            revision: 0,
            sampled_at_unix_ms: 0,
            emitted_at_unix_ms: 0,
            event_sequence: 0,
            available: false,
            instance_id: None,
            clip_index: None,
            time: 0.0,
            duration: 0.0,
            playing: false,
            looping: false,
            command_results: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
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

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelinePlaybackCommandEnvelope {
    pub epoch: u64,
    pub request_id: u64,
    pub command: TimelinePlaybackCommand,
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
        if instance_id.len() > MAX_RUNTIME_ID_BYTES {
            return Err(format!(
                "timeline playback instanceId exceeds the {MAX_RUNTIME_ID_BYTES}-byte limit"
            ));
        }
        let clip_index = match self {
            Self::Play { clip_index, .. }
            | Self::Pause { clip_index, .. }
            | Self::Seek { clip_index, .. }
            | Self::SetLooping { clip_index, .. } => *clip_index,
        };
        if (clip_index as u64) > MAX_JS_SAFE_INTEGER {
            return Err(format!(
                "timeline playback clipIndex must not exceed JavaScript safe integer {MAX_JS_SAFE_INTEGER}"
            ));
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

type PlaybackEventTarget = (bool, Option<String>, Option<usize>);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePlaybackCommandResult {
    pub sequence: u64,
    pub request_id: u64,
    pub epoch: u64,
    pub instance_id: String,
    pub clip_index: usize,
    pub command_type: String,
    pub applied: bool,
    pub error: Option<String>,
}

pub struct TimelinePlaybackStore {
    pending: Mutex<VecDeque<TimelinePlaybackCommandEnvelope>>,
    recent_request_ids: Mutex<VecDeque<u64>>,
    accepting_commands: AtomicBool,
    snapshot: Mutex<TimelinePlaybackSnapshot>,
    pending_unavailable_event: Mutex<bool>,
    pending_semantic_event: Mutex<bool>,
    last_event_at: Mutex<Option<Instant>>,
    last_event_target: Mutex<Option<PlaybackEventTarget>>,
    next_event_sequence: Mutex<u64>,
    next_command_result_sequence: Mutex<u64>,
}

const MAX_PENDING_PLAYBACK_COMMANDS: usize = 256;
const MAX_RECENT_REQUEST_IDS: usize = 256;
const MAX_COMMAND_RESULTS: usize = 32;

impl Default for TimelinePlaybackStore {
    fn default() -> Self {
        Self {
            pending: Mutex::new(VecDeque::new()),
            recent_request_ids: Mutex::new(VecDeque::new()),
            accepting_commands: AtomicBool::new(true),
            snapshot: Mutex::new(TimelinePlaybackSnapshot::default()),
            pending_unavailable_event: Mutex::new(false),
            pending_semantic_event: Mutex::new(false),
            last_event_at: Mutex::new(None),
            last_event_target: Mutex::new(None),
            next_event_sequence: Mutex::new(0),
            next_command_result_sequence: Mutex::new(0),
        }
    }
}

impl TimelinePlaybackStore {
    /// Gate command admission at the Native lifecycle boundary. The release
    /// store happens before clearing the queue so a concurrent request either
    /// observes the inactive gate or is removed by the clear.
    pub fn set_accepting_commands(&self, accepting: bool) {
        self.accepting_commands.store(accepting, Ordering::Release);
        if !accepting {
            self.pending.lock().unwrap().clear();
            self.recent_request_ids.lock().unwrap().clear();
        }
    }

    pub fn request(&self, envelope: TimelinePlaybackCommandEnvelope) -> Result<(), String> {
        if !self.accepting_commands.load(Ordering::Acquire) {
            return Err(
                "Native renderer is inactive; timeline playback command was rejected".to_string(),
            );
        }
        if envelope.request_id == 0 || envelope.request_id > MAX_REQUEST_ID {
            return Err(format!(
                "timeline playback requestId must be between 1 and {MAX_REQUEST_ID}"
            ));
        }
        if envelope.epoch == 0 || envelope.epoch > MAX_JS_SAFE_INTEGER {
            return Err(format!(
                "timeline playback epoch must be between 1 and {MAX_JS_SAFE_INTEGER}"
            ));
        }
        envelope.command.validate()?;
        let current = self.snapshot.lock().unwrap();
        let current_epoch = current.epoch.max(1);
        let mut pending = self.pending.lock().unwrap();
        let mut recent_request_ids = self.recent_request_ids.lock().unwrap();
        if !self.accepting_commands.load(Ordering::Acquire) {
            return Err(
                "Native renderer is inactive; timeline playback command was rejected".to_string(),
            );
        }
        if envelope.epoch != current_epoch {
            return Err(format!(
                "stale timeline playback epoch {}; current epoch is {}",
                envelope.epoch, current_epoch
            ));
        }
        if recent_request_ids.contains(&envelope.request_id) {
            return Err(format!(
                "timeline playback requestId {} was already accepted",
                envelope.request_id
            ));
        }
        if let Some(last) = pending.back_mut() {
            let can_coalesce = match (&last.command, &envelope.command) {
                (
                    TimelinePlaybackCommand::Seek {
                        instance_id: last_instance,
                        clip_index: last_clip,
                        ..
                    },
                    TimelinePlaybackCommand::Seek {
                        instance_id,
                        clip_index,
                        ..
                    },
                ) => {
                    last.epoch == envelope.epoch
                        && last_instance == instance_id
                        && last_clip == clip_index
                }
                _ => false,
            };
            if can_coalesce {
                *last = envelope;
                remember_request_id(&mut recent_request_ids, last.request_id);
                return Ok(());
            }
        }
        if pending.len() >= MAX_PENDING_PLAYBACK_COMMANDS {
            return Err("timeline playback queue is full; command was rejected".to_string());
        }
        pending.push_back(envelope);
        remember_request_id(&mut recent_request_ids, pending.back().unwrap().request_id);
        Ok(())
    }

    pub fn take_commands(&self) -> Vec<TimelinePlaybackCommandEnvelope> {
        self.pending.lock().unwrap().drain(..).collect()
    }

    pub fn is_current_epoch(&self, envelope: &TimelinePlaybackCommandEnvelope) -> bool {
        envelope.epoch == self.current_epoch()
    }

    pub fn current_epoch(&self) -> u64 {
        self.snapshot.lock().unwrap().epoch.max(1)
    }

    /// Advance the playback generation and clear commands captured from the
    /// previous Scene. The unavailable snapshot gives the frontend an
    /// explicit replacement boundary before the next renderer sample.
    pub fn replace_scene(&self) -> u64 {
        let mut snapshot = self.snapshot.lock().unwrap();
        let mut pending = self.pending.lock().unwrap();
        pending.clear();
        self.recent_request_ids.lock().unwrap().clear();
        let epoch = snapshot.epoch.max(1).saturating_add(1);
        *snapshot = TimelinePlaybackSnapshot {
            epoch,
            ..Default::default()
        };
        *self.pending_unavailable_event.lock().unwrap() = true;
        *self.pending_semantic_event.lock().unwrap() = false;
        drop(pending);
        drop(snapshot);
        *self.last_event_at.lock().unwrap() = None;
        *self.last_event_target.lock().unwrap() = None;
        epoch
    }

    pub fn record_command_result(
        &self,
        envelope: &TimelinePlaybackCommandEnvelope,
        result: Result<(), String>,
    ) {
        let (instance_id, clip_index) = envelope.command.target();
        let command_type = match &envelope.command {
            TimelinePlaybackCommand::Play { .. } => "play",
            TimelinePlaybackCommand::Pause { .. } => "pause",
            TimelinePlaybackCommand::Seek { .. } => "seek",
            TimelinePlaybackCommand::SetLooping { .. } => "setLooping",
        };
        let mut snapshot = self.snapshot.lock().unwrap();
        let mut sequence = self.next_command_result_sequence.lock().unwrap();
        *sequence = sequence.saturating_add(1);
        let (applied, error) = match result {
            Ok(()) => (true, None),
            Err(error) => (false, Some(diagnostic_text(&error))),
        };
        snapshot
            .command_results
            .push(TimelinePlaybackCommandResult {
                sequence: *sequence,
                request_id: envelope.request_id,
                epoch: envelope.epoch,
                instance_id: instance_id.to_string(),
                clip_index,
                command_type: command_type.to_string(),
                applied,
                error,
            });
        if snapshot.command_results.len() > MAX_COMMAND_RESULTS {
            let excess = snapshot.command_results.len() - MAX_COMMAND_RESULTS;
            snapshot.command_results.drain(..excess);
        }
        snapshot.revision = snapshot.revision.saturating_add(1);
        *self.pending_semantic_event.lock().unwrap() = true;
    }

    pub fn publish(&self, mut snapshot: TimelinePlaybackSnapshot) -> bool {
        let mut current = self.snapshot.lock().unwrap();
        snapshot.epoch = current.epoch.max(1);
        if playback_payload_equal(&current, &snapshot) {
            return false;
        }
        // Command acknowledgements are store-owned. Move the bounded history
        // into the new snapshot instead of cloning it on every time sample.
        snapshot.command_results = std::mem::take(&mut current.command_results);
        snapshot.revision = current.revision.saturating_add(1);
        snapshot.sampled_at_unix_ms = unix_now_ms();
        snapshot.emitted_at_unix_ms = 0;
        snapshot.event_sequence = 0;
        *current = snapshot;
        *self.pending_semantic_event.lock().unwrap() = true;
        true
    }

    pub fn has_pending_unavailable_event(&self) -> bool {
        *self.pending_unavailable_event.lock().unwrap()
    }

    pub fn has_pending_semantic_event(&self) -> bool {
        *self.pending_semantic_event.lock().unwrap()
    }

    /// Mark the Native timeline unavailable exactly once while its renderer is
    /// parked. Pending commands are dropped at this boundary because they
    /// target the inactive renderer and must not leak into the next active
    /// frame.
    pub fn publish_unavailable_if_needed(&self) -> bool {
        let mut snapshot = self.snapshot.lock().unwrap();
        if !snapshot.available {
            let pending_unavailable = *self.pending_unavailable_event.lock().unwrap();
            let pending_semantic = *self.pending_semantic_event.lock().unwrap();
            return pending_unavailable || pending_semantic;
        }
        let mut pending = self.pending.lock().unwrap();
        pending.clear();
        let epoch = snapshot.epoch.max(1);
        let revision = snapshot.revision.saturating_add(1);
        let command_results = snapshot.command_results.clone();
        *snapshot = TimelinePlaybackSnapshot {
            epoch,
            revision,
            command_results,
            ..Default::default()
        };
        *self.pending_unavailable_event.lock().unwrap() = true;
        *self.pending_semantic_event.lock().unwrap() = false;
        true
    }

    pub fn snapshot(&self) -> TimelinePlaybackSnapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn take_event_snapshot(
        &self,
        minimum_interval_ms: u64,
    ) -> Option<TimelinePlaybackSnapshot> {
        let snapshot = self.snapshot();
        let force_unavailable_event = if snapshot.available {
            *self.pending_unavailable_event.lock().unwrap() = false;
            false
        } else {
            *self.pending_unavailable_event.lock().unwrap()
        };
        let pending_semantic_event = *self.pending_semantic_event.lock().unwrap();
        let now = Instant::now();
        let target = (
            snapshot.available,
            snapshot.instance_id.clone(),
            snapshot.clip_index,
        );
        let mut last_target = self.last_event_target.lock().unwrap();
        let target_changed = last_target.as_ref() != Some(&target);
        if !snapshot.available
            && !target_changed
            && !force_unavailable_event
            && !pending_semantic_event
        {
            return None;
        }
        let mut last_event = self.last_event_at.lock().unwrap();
        if !force_unavailable_event
            && !target_changed
            && last_event.is_some_and(|previous| {
                now.duration_since(previous) < Duration::from_millis(minimum_interval_ms)
            })
        {
            return None;
        }
        *last_event = Some(now);
        *last_target = Some(target);
        let mut event_sequence = self.next_event_sequence.lock().unwrap();
        *event_sequence = event_sequence.saturating_add(1);
        let mut emitted_snapshot = snapshot;
        emitted_snapshot.event_sequence = *event_sequence;
        emitted_snapshot.emitted_at_unix_ms = unix_now_ms();
        if force_unavailable_event {
            *self.pending_unavailable_event.lock().unwrap() = false;
        }
        if pending_semantic_event {
            *self.pending_semantic_event.lock().unwrap() = false;
        }
        Some(emitted_snapshot)
    }
}

fn playback_payload_equal(
    current: &TimelinePlaybackSnapshot,
    next: &TimelinePlaybackSnapshot,
) -> bool {
    current.epoch == next.epoch
        && current.available == next.available
        && current.instance_id == next.instance_id
        && current.clip_index == next.clip_index
        && current.time == next.time
        && current.duration == next.duration
        && current.playing == next.playing
        && current.looping == next.looping
}

fn remember_request_id(recent: &mut VecDeque<u64>, request_id: u64) {
    recent.push_back(request_id);
    if recent.len() > MAX_RECENT_REQUEST_IDS {
        recent.pop_front();
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_seek_and_preserves_command_order() {
        let store = TimelinePlaybackStore::default();
        assert!(store
            .request(TimelinePlaybackCommandEnvelope {
                epoch: 1,
                request_id: 1,
                command: TimelinePlaybackCommand::Seek {
                    instance_id: "model".to_string(),
                    clip_index: 0,
                    time: f32::NAN,
                },
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
        store
            .request(TimelinePlaybackCommandEnvelope {
                epoch: 1,
                request_id: 2,
                command: play.clone(),
            })
            .unwrap();
        store
            .request(TimelinePlaybackCommandEnvelope {
                epoch: 1,
                request_id: 3,
                command: pause.clone(),
            })
            .unwrap();
        assert_eq!(
            store.take_commands(),
            vec![
                TimelinePlaybackCommandEnvelope {
                    epoch: 1,
                    request_id: 2,
                    command: play,
                },
                TimelinePlaybackCommandEnvelope {
                    epoch: 1,
                    request_id: 3,
                    command: pause,
                }
            ]
        );
    }

    #[test]
    fn inactive_gate_rejects_and_clears_commands_until_reactivated() {
        let store = TimelinePlaybackStore::default();
        let command = TimelinePlaybackCommandEnvelope {
            epoch: 1,
            request_id: 4,
            command: TimelinePlaybackCommand::Play {
                instance_id: "model".to_string(),
                clip_index: 0,
            },
        };
        store.request(command.clone()).unwrap();
        store.set_accepting_commands(false);
        assert!(store.take_commands().is_empty());
        let error = store
            .request(command.clone())
            .expect_err("inactive Native must reject playback commands");
        assert!(error.contains("renderer is inactive"));

        store.set_accepting_commands(true);
        let reactivated_command = TimelinePlaybackCommandEnvelope {
            request_id: 4,
            ..command
        };
        store
            .request(reactivated_command)
            .expect("reactivated Native accepts playback commands");
        assert_eq!(store.take_commands().len(), 1);
    }

    #[test]
    fn rejects_oversized_timeline_instance_ids() {
        let store = TimelinePlaybackStore::default();
        let error = store
            .request(TimelinePlaybackCommandEnvelope {
                epoch: 1,
                request_id: 5,
                command: TimelinePlaybackCommand::Play {
                    instance_id: "i".repeat(MAX_RUNTIME_ID_BYTES + 1),
                    clip_index: 0,
                },
            })
            .expect_err("timeline instance IDs must be bounded");
        assert!(error.contains("instanceId"));
        assert!(store.take_commands().is_empty());
    }

    #[test]
    fn rejects_request_ids_outside_javascript_safe_range() {
        let store = TimelinePlaybackStore::default();
        for request_id in [0, MAX_REQUEST_ID + 1] {
            let error = store
                .request(TimelinePlaybackCommandEnvelope {
                    epoch: 1,
                    request_id,
                    command: TimelinePlaybackCommand::Play {
                        instance_id: "model".to_string(),
                        clip_index: 0,
                    },
                })
                .expect_err("request IDs must be safe and non-zero");
            assert!(error.contains("requestId"));
        }
        assert!(store.take_commands().is_empty());
    }

    #[test]
    fn rejects_epochs_outside_javascript_safe_range() {
        let store = TimelinePlaybackStore::default();
        for epoch in [0, MAX_JS_SAFE_INTEGER + 1] {
            let error = store
                .request(TimelinePlaybackCommandEnvelope {
                    epoch,
                    request_id: 1,
                    command: TimelinePlaybackCommand::Play {
                        instance_id: "model".to_string(),
                        clip_index: 0,
                    },
                })
                .expect_err("epochs must be positive JavaScript-safe integers");
            assert!(error.contains("epoch"));
        }
        assert!(store.take_commands().is_empty());
    }

    #[test]
    fn rejects_duplicate_request_id_without_replacing_pending_command() {
        let store = TimelinePlaybackStore::default();
        let first = TimelinePlaybackCommandEnvelope {
            epoch: 1,
            request_id: 21,
            command: TimelinePlaybackCommand::Play {
                instance_id: "model".to_string(),
                clip_index: 0,
            },
        };
        store.request(first.clone()).unwrap();
        let duplicate = TimelinePlaybackCommandEnvelope {
            command: TimelinePlaybackCommand::Pause {
                instance_id: "model".to_string(),
                clip_index: 0,
            },
            ..first
        };
        let error = store
            .request(duplicate)
            .expect_err("requestId replay must not execute twice");
        assert!(error.contains("already accepted"));
        assert_eq!(store.take_commands().len(), 1);
    }

    #[test]
    fn consecutive_seeks_coalesce_to_the_latest_time() {
        let store = TimelinePlaybackStore::default();
        for (index, time) in [0.25, 0.75, 1.5].into_iter().enumerate() {
            store
                .request(TimelinePlaybackCommandEnvelope {
                    epoch: 1,
                    request_id: (index + 1) as u64,
                    command: TimelinePlaybackCommand::Seek {
                        instance_id: "model".to_string(),
                        clip_index: 0,
                        time,
                    },
                })
                .unwrap();
        }

        assert_eq!(
            store.take_commands(),
            vec![TimelinePlaybackCommandEnvelope {
                epoch: 1,
                request_id: 3,
                command: TimelinePlaybackCommand::Seek {
                    instance_id: "model".to_string(),
                    clip_index: 0,
                    time: 1.5,
                },
            }]
        );
    }

    #[test]
    fn rejects_new_commands_when_pending_queue_reaches_bound() {
        let store = TimelinePlaybackStore::default();
        for index in 0..MAX_PENDING_PLAYBACK_COMMANDS {
            store
                .request(TimelinePlaybackCommandEnvelope {
                    epoch: 1,
                    request_id: (index + 1) as u64,
                    command: TimelinePlaybackCommand::Play {
                        instance_id: format!("model-{index}"),
                        clip_index: 0,
                    },
                })
                .unwrap();
        }
        let error = store
            .request(TimelinePlaybackCommandEnvelope {
                epoch: 1,
                request_id: (MAX_PENDING_PLAYBACK_COMMANDS + 1) as u64,
                command: TimelinePlaybackCommand::Play {
                    instance_id: "overflow".to_string(),
                    clip_index: 0,
                },
            })
            .expect_err("pending playback queue must be bounded");
        assert!(error.contains("queue is full"));
        assert_eq!(store.take_commands().len(), MAX_PENDING_PLAYBACK_COMMANDS);
    }

    #[test]
    fn seek_coalescing_does_not_cross_pause_boundary() {
        let store = TimelinePlaybackStore::default();
        let seek = |request_id, time| TimelinePlaybackCommandEnvelope {
            epoch: 1,
            request_id,
            command: TimelinePlaybackCommand::Seek {
                instance_id: "model".to_string(),
                clip_index: 0,
                time,
            },
        };
        store.request(seek(1, 0.25)).unwrap();
        store
            .request(TimelinePlaybackCommandEnvelope {
                epoch: 1,
                request_id: 2,
                command: TimelinePlaybackCommand::Pause {
                    instance_id: "model".to_string(),
                    clip_index: 0,
                },
            })
            .unwrap();
        store.request(seek(3, 1.5)).unwrap();
        assert!(store
            .request(seek(1, 2.0))
            .expect_err("a coalesced seek's old requestId must remain consumed")
            .contains("already accepted"));

        let commands = store.take_commands();
        assert_eq!(commands.len(), 3);
        assert!(matches!(
            commands[0].command,
            TimelinePlaybackCommand::Seek { time, .. } if time == 0.25
        ));
        assert!(matches!(
            commands[1].command,
            TimelinePlaybackCommand::Pause { .. }
        ));
        assert!(matches!(
            commands[2].command,
            TimelinePlaybackCommand::Seek { time, .. } if time == 1.5
        ));
    }

    #[test]
    fn publish_advances_revision() {
        let store = TimelinePlaybackStore::default();
        assert!(store.publish(TimelinePlaybackSnapshot {
            available: true,
            ..Default::default()
        }));
        assert_eq!(store.snapshot().revision, 1);
        assert!(store.snapshot().sampled_at_unix_ms > 0);
        assert_eq!(store.snapshot().emitted_at_unix_ms, 0);
        assert_eq!(store.snapshot().event_sequence, 0);
        assert!(store.snapshot().available);
    }

    #[test]
    fn identical_paused_snapshot_does_not_advance_revision_or_emit_again() {
        let store = TimelinePlaybackStore::default();
        let snapshot = TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            time: 1.25,
            duration: 3.0,
            playing: false,
            looping: true,
            ..Default::default()
        };
        assert!(store.publish(snapshot.clone()));
        assert!(store.take_event_snapshot(0).is_some());
        let revision = store.snapshot().revision;
        assert!(!store.publish(snapshot));
        assert_eq!(store.snapshot().revision, revision);
        assert!(store.take_event_snapshot(250).is_none());
    }

    #[test]
    fn throttled_semantic_change_emits_latest_snapshot_on_later_poll() {
        let store = TimelinePlaybackStore::default();
        let initial = TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            time: 1.0,
            duration: 3.0,
            playing: false,
            looping: false,
            ..Default::default()
        };
        assert!(store.publish(initial.clone()));
        assert!(store.take_event_snapshot(250).is_some());

        let changed = TimelinePlaybackSnapshot {
            time: 1.5,
            ..initial
        };
        assert!(store.publish(changed.clone()));
        assert!(store.has_pending_semantic_event());
        assert!(store.take_event_snapshot(250).is_none());
        assert!(store.has_pending_semantic_event());
        assert!(!store.publish(changed));

        *store.last_event_at.lock().unwrap() = Some(Instant::now() - Duration::from_millis(251));
        let emitted = store
            .take_event_snapshot(250)
            .expect("the pending semantic change must emit after throttling");
        assert_eq!(emitted.time, 1.5);
        assert!(!store.has_pending_semantic_event());
    }

    #[test]
    fn semantic_time_change_advances_revision() {
        let store = TimelinePlaybackStore::default();
        assert!(store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            time: 1.0,
            duration: 3.0,
            ..Default::default()
        }));
        let revision = store.snapshot().revision;
        assert!(store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            time: 1.25,
            duration: 3.0,
            ..Default::default()
        }));
        assert_eq!(store.snapshot().revision, revision + 1);
    }

    #[test]
    fn playing_snapshot_with_same_time_is_still_semantically_static() {
        let store = TimelinePlaybackStore::default();
        let snapshot = TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            time: 1.0,
            duration: 3.0,
            playing: true,
            ..Default::default()
        };
        assert!(store.publish(snapshot.clone()));
        let revision = store.snapshot().revision;
        assert!(!store.publish(snapshot));
        assert_eq!(store.snapshot().revision, revision);
    }

    #[test]
    fn emitted_event_has_timestamp_and_monotonic_sequence() {
        let store = TimelinePlaybackStore::default();
        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            ..Default::default()
        });
        let first = store.take_event_snapshot(0).unwrap();
        assert_eq!(first.event_sequence, 1);
        assert!(first.emitted_at_unix_ms >= first.sampled_at_unix_ms);
        let wire = serde_json::to_value(&first).unwrap();
        assert!(wire.get("emittedAtUnixMs").is_some());
        assert_eq!(
            wire.get("eventSequence").and_then(|value| value.as_u64()),
            Some(1)
        );

        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".into()),
            clip_index: Some(0),
            ..Default::default()
        });
        let second = store.take_event_snapshot(0).unwrap();
        assert_eq!(second.event_sequence, 2);
        assert!(second.emitted_at_unix_ms >= second.sampled_at_unix_ms);
        assert!(second.emitted_at_unix_ms >= first.emitted_at_unix_ms);
    }

    #[test]
    fn command_deserializes_typescript_wire_shape() {
        let command: TimelinePlaybackCommandEnvelope = serde_json::from_str(
            r#"{"epoch":1,"requestId":17,"command":{"type":"seek","instanceId":"model","clipIndex":2,"time":1.25}}"#,
        )
        .unwrap();
        assert_eq!(command.epoch, 1);
        assert_eq!(command.request_id, 17);
        assert_eq!(
            command.command,
            TimelinePlaybackCommand::Seek {
                instance_id: "model".to_string(),
                clip_index: 2,
                time: 1.25,
            }
        );
    }

    #[test]
    fn command_wire_rejects_unknown_fields() {
        let command = serde_json::from_str::<TimelinePlaybackCommand>(
            r#"{"type":"seek","instanceId":"model","clipIndex":2,"time":1.25,"future":true}"#,
        );
        assert!(command.is_err());

        let envelope = serde_json::from_str::<TimelinePlaybackCommandEnvelope>(
            r#"{"epoch":1,"requestId":17,"command":{"type":"seek","instanceId":"model","clipIndex":2,"time":1.25},"future":true}"#,
        );
        assert!(envelope.is_err());
    }

    #[test]
    fn rejects_clip_index_outside_javascript_safe_integer_range() {
        let Some(clip_index) = usize::try_from(MAX_JS_SAFE_INTEGER + 1).ok() else {
            return;
        };
        let error = TimelinePlaybackCommand::Play {
            instance_id: "model".to_string(),
            clip_index,
        }
        .validate()
        .expect_err("clipIndex must remain representable in the JavaScript wire");
        assert!(error.contains("clipIndex"));
        assert!(error.contains("safe integer"));
    }

    #[test]
    fn command_results_are_bounded_and_survive_renderer_publish() {
        let store = TimelinePlaybackStore::default();
        let command = TimelinePlaybackCommandEnvelope {
            epoch: 1,
            request_id: 10,
            command: TimelinePlaybackCommand::Seek {
                instance_id: "model".to_string(),
                clip_index: 0,
                time: 1.25,
            },
        };
        store.request(command.clone()).unwrap();
        let queued = store.take_commands().pop().unwrap();
        store.record_command_result(&queued, Err("clip\nunavailable".to_string()));

        let result = &store.snapshot().command_results[0];
        assert_eq!(result.request_id, 10);
        assert_eq!(result.epoch, 1);
        assert_eq!(result.instance_id, "model");
        assert_eq!(result.clip_index, 0);
        assert_eq!(result.command_type, "seek");
        assert!(!result.applied);
        assert_eq!(result.error.as_deref(), Some("clip\\nunavailable"));

        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".to_string()),
            clip_index: Some(0),
            ..Default::default()
        });
        assert_eq!(store.snapshot().command_results.len(), 1);

        for _ in 0..(MAX_COMMAND_RESULTS + 4) {
            store.record_command_result(&queued, Ok(()));
        }
        assert_eq!(store.snapshot().command_results.len(), MAX_COMMAND_RESULTS);
    }

    #[test]
    fn replacement_clears_pending_and_rejects_old_epoch_even_for_reused_target() {
        let store = TimelinePlaybackStore::default();
        let old = TimelinePlaybackCommandEnvelope {
            epoch: 1,
            request_id: 11,
            command: TimelinePlaybackCommand::Play {
                instance_id: "model".to_string(),
                clip_index: 0,
            },
        };
        store.request(old.clone()).unwrap();
        assert_eq!(store.replace_scene(), 2);
        assert!(store.take_commands().is_empty());
        assert!(!store.is_current_epoch(&old));
        let error = store
            .request(old)
            .expect_err("old Scene command must be rejected");
        assert!(error.contains("stale timeline playback epoch"));
        assert_eq!(store.current_epoch(), 2);
    }

    #[test]
    fn inactive_transition_publishes_one_unavailable_snapshot_and_event() {
        let store = TimelinePlaybackStore::default();
        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".to_string()),
            clip_index: Some(0),
            time: 1.25,
            playing: true,
            ..Default::default()
        });
        let before = store.snapshot();
        store
            .request(TimelinePlaybackCommandEnvelope {
                epoch: before.epoch,
                request_id: 12,
                command: TimelinePlaybackCommand::Seek {
                    instance_id: "model".to_string(),
                    clip_index: 0,
                    time: 2.0,
                },
            })
            .unwrap();

        assert!(store.publish_unavailable_if_needed());
        let unavailable = store.snapshot();
        assert_eq!(unavailable.epoch, before.epoch);
        assert_eq!(unavailable.revision, before.revision + 1);
        assert!(!unavailable.available);
        assert_eq!(unavailable.instance_id, None);
        assert_eq!(unavailable.time, 0.0);
        assert!(!unavailable.playing);
        assert!(store.take_commands().is_empty());
        assert!(store.take_event_snapshot(0).is_some());

        assert!(!store.publish_unavailable_if_needed());
        assert_eq!(store.snapshot().revision, unavailable.revision);
        assert!(store.take_event_snapshot(250).is_none());

        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("model".to_string()),
            clip_index: Some(0),
            ..Default::default()
        });
        let resumed = store.snapshot();
        assert_eq!(resumed.epoch, unavailable.epoch);
        assert_eq!(resumed.revision, unavailable.revision + 1);
        assert!(resumed.available);
    }

    #[test]
    fn replacement_forces_one_unavailable_event_after_target_reset() {
        let store = TimelinePlaybackStore::default();
        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("old-model".to_string()),
            clip_index: Some(0),
            playing: true,
            ..Default::default()
        });
        assert!(store.take_event_snapshot(0).is_some());

        let epoch = store.replace_scene();
        assert_eq!(epoch, 2);
        assert!(store.publish_unavailable_if_needed());
        let event = store
            .take_event_snapshot(250)
            .expect("replacement must emit unavailable boundary");
        assert_eq!(event.epoch, epoch);
        assert!(!event.available);
        assert!(store.take_event_snapshot(0).is_none());
        assert!(!store.publish_unavailable_if_needed());
    }

    #[test]
    fn available_replacement_snapshot_supersedes_pending_unavailable_event() {
        let store = TimelinePlaybackStore::default();
        let epoch = store.replace_scene();
        store.publish(TimelinePlaybackSnapshot {
            available: true,
            instance_id: Some("new-model".to_string()),
            clip_index: Some(0),
            ..Default::default()
        });

        let event = store
            .take_event_snapshot(250)
            .expect("available replacement snapshot should emit");
        assert_eq!(event.epoch, epoch);
        assert!(event.available);
        assert!(store.take_event_snapshot(250).is_none());
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
