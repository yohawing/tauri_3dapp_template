# Temporal Editor read-only preview — 完了記録

完了日: 2026-08-08以前

Timelineの次段階を後回しにするため、旧`TODO.md`の完了内容をここへ要約する。詳細設計は[`../TIMELINE_PLAN.md`](../TIMELINE_PLAN.md)を参照する。

## 完了した範囲

- fixture由来のread-only Timeline UI
- header、toolbar、Track Tree、ruler、grid、scroll rows、playhead
- Canvas 2DによるClip、Key、Marker、EventCue描画
- selected／hovered／mute／lockの見た目
- Dock resize、scroll、DPR 1.5での位置・鮮明度確認
- UI／React非依存の`src/timeline/core/`契約
- `TimeValue`、`TimeRange`、`ViewTransform`、opaque ID、revision
- `TimelineRow`、Clip、Cue、Marker、Channel、Key、Group、Binding
- read-only `TimelineDataSource`とin-memory fixture adapter
- Seconds／Ticks、half-open range、kind分離のcontract test
- frontend build、contract test、Tauri実機目視

## 意図的に未実装

- Rust `TemporalDocument`、IPC、Projection同期
- selection、drag、trim、snap、box selection
- `TimelineCommand`、Transaction、History、Undo／Redo
- event評価、playback、scrub
- 大規模virtualization／benchmark
- Graph Editor、Dope Sheet、Clip Editor

これらをactive TODOへ戻すかは、Scene JSONのPoCが完了した後に別途判断する。
