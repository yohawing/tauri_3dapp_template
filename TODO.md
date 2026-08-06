# Tauri Native WGPU Hybrid Viewport PoC TODO

参照: `tauri_wgpu_hybrid_viewport_poc_plan.md`

## 目的と完了条件

Tauri 2 の透明 WebView と native wgpu Viewport の組み合わせが、DCC アプリの基盤として採用可能かを実測で判断する。

PoC の完了条件は次のとおり。

- Windows と macOS で native Viewport、DOM UI、Canvas fallback が同一レイアウト内で動く。
- Resize、DPI 変更、入力、Backend 切替、Surface Lost の挙動を再現可能な手順と計測結果で説明できる。
- 継続、Tao + Wry への移行、Electrobun への移行、中止のいずれかを根拠付きで決定できる。

## 非目標

- 完成版 DCC、複数 Window／Viewport、Undo／Redo、Node Editor、製品品質の Timeline は作らない。
- Native と Canvas の描画機能を完全一致させない。Canvas は Safe Mode／Preview に限定する。
- GPU Resource を Native と Canvas で共有しない。
- Linux／Wayland、Mac App Store、署名・notarization の完了は本 PoC に含めない。
- 採否ゲートを通る前に PMX／VMD、Retarget、Physics へ広げない。

## 現在地（2026-08-06）

実装済み。ただし、下記の基盤復旧と実機証拠化が終わるまでは「検証済み」と扱わない。

- [x] Tauri 2 + React + TypeScript + Vite の Skeleton
- [x] 透明 Window／WebView と native wgpu Surface
- [x] native colored cube、Viewport／Scissor、Depth
- [x] DOM Viewport 矩形、Window Resize、DPI 変更の同期経路
- [x] Pointer／Wheel 転送と native Orbit Camera
- [x] Three.js Canvas backend と手動切替、Camera の往復同期
- [x] dockview、Outliner、Inspector、Timeline mock の DCC シェル
- [x] Surface の Suboptimal／Outdated／Lost 時の再 configure（実機検証は未実施）

既知の未完了／問題。

- [ ] `npm run build` は依存未導入のため `tsc` が見つからず失敗する。
- [x] `gpu-allocator` の依存 edge を `windows 0.62.2` へ固定し、`wgpu-hal 30.0.0` の型競合を解消した。
- [ ] native Renderer 初期化は `expect` で終了し、自動 Canvas fallback しない。
- [ ] glTF、Native canonical Scene、Picking、Selection、Gizmo、File Drop は未実装。
- [ ] Windows／macOS の実機計測結果と採否記録がない。

## 実行順

### P0 — 再現可能な green baseline を作る

依存: なし。これが全作業の前提。

- [ ] `npm ci` 後に `npm run build` を通す。
- [x] `cargo tree -i windows` と `cargo tree -i windows-core` で競合導入元を特定する。
- [x] Tauri／wgpu／gpu-allocator の互換組み合わせへ固定し、`cargo check --locked` を通す。
- [ ] Rust の純粋ロジック（Camera、矩形の物理 pixel 変換／clamp）へ単体テストを追加する。
- [ ] `npm run build`、`cargo test --locked`、`cargo check --locked` を一括実行する検証コマンドを用意する。
- [ ] README に Node、Rust、OS、起動／検証手順を記載する。

完了条件: clean checkout から記載手順だけで依存を復元でき、上記 gate がすべて green になる。

### P1 — Windows で hybrid viewport の成立性を証拠化する

依存: P0。

- [ ] Windows で native wgpu が透明 WebView 背面に表示されることをスクリーンショットと実行ログで残す。
- [ ] Toolbar、Outliner、Inspector、Timeline、Popup／Modal が Viewport 上で欠けずに重なることを確認する。
- [ ] Dock resize と panel move の前後で DOM rect と適用 physical rect を同一 sequence ID で記録する。
- [ ] 100／125／150／200% DPI と異なる DPI の monitor 間移動を確認する。
- [ ] Window の最大化、最小化、復元、連続 resize 後に矩形ずれや描画停止がないことを確認する。
- [ ] Orbit、Pan、Zoom、pointer capture、Viewport 外へ出る drag を確認する。
- [ ] Native → Canvas → Native を反復し、Camera continuity と native 描画停止／再開を確認する。
- [ ] 1080p と 4K で FPS、CPU frame time、GPU time、RAM／VRAM、入力遅延、rect ずれを記録する。
- [ ] native 非 active 時も続く 16ms wake loop を計測し、不要なら event-driven／可変 cadence にする。
- [ ] 手順、環境、期待値、実測値、スクリーンショットを `docs/` の検証記録へまとめる。

完了条件: 必須ケースが再現手順付きで pass し、1080p 60fps、入力遅延、rect ずれについて採否判断に使える数値がある。

見直し条件: 透明合成、rect 同期、入力のいずれかが DCC 操作に耐えない場合、P3 以降へ進まず Tao + Wry／Electrobun／中止を比較する。

### P2 — Renderer 障害を Canvas fallback へ閉じ込める

依存: P1 の成立性確認。

- [ ] `Renderer::new` を `Result` 化し、Surface／Adapter／Device／Pipeline 初期化エラーを分類する。
- [ ] Renderer の状態を `Initializing | NativeReady | CanvasFallback | Recovering | Failed` として protocol 化する。
- [ ] native 初期化失敗時も Tauri app と Web UI を起動し、Canvas mode へ自動切替する。
- [ ] 強制失敗用の開発フラグを追加し、自動 fallback を決定論的に検証する。
- [ ] Surface Lost／Outdated、Device Lost、Sleep 復帰時の再初期化方針と retry 上限を実装する。
- [ ] 自動 fallback の理由と復旧操作を UI に表示する。
- [ ] Native と Canvas を同時描画せず、inactive backend が連続描画しないことを計測する。

完了条件: 強制初期化失敗、Surface Lost、復旧失敗の各ケースで app が落ちず、Canvas 表示または明示的な error state に到達する。

### P3 — Tauri から core／renderer／protocol を分離する

依存: P2。P4 の Scene 実装前に境界を固定する。

- [ ] Cargo workspace を作り、`editor-protocol`、`cg-core`、`renderer-wgpu`、`desktop-shell-tauri` の責務を分ける。
- [ ] Camera、ViewportRect、RendererStatus、SceneSnapshot を Tauri 型から独立させる。
- [ ] Frontend と Rust の DTO field／enum 対応を contract test で固定する。
- [ ] 高頻度 PointerMove は最新値上書き、低頻度 command は通常 IPC、状態通知は event／channel として経路を分ける。
- [ ] Shell 交換時に core と renderer を変更しない境界になっているかレビューする。

完了条件: Tauri 非依存 crate の test が単独で通り、desktop shell は lifecycle と IPC wiring のみを担当する。

### P4 — 最小の canonical Scene と glTF 往復表示を作る

依存: P3。

- [ ] Native Rust 側に Entity、Transform、Mesh、Camera、Selection の最小 Scene model を作る。
- [ ] 小さく再配布可能な GLB fixture と期待値を `assets/` に置く。
- [ ] File dialog と File Drop から GLB を Native 側へ読み込む。
- [ ] Native wgpu で fixture を描画する。
- [ ] React の Outliner／Inspector を mock から Native UI Projection に置き換える。
- [ ] Canvas backend は Native の軽量 SceneSnapshot を受け、同じ fixture を表示する。
- [ ] Backend 切替後も Scene、Selection、Camera が維持されることを確認する。
- [ ] 不正／非対応 glTF を error state として表示し、app を落とさない。

完了条件: 同じ GLB と canonical state が Native／Canvas／Outliner／Inspector に反映され、backend 固有 state が正本にならない。

### P5 — 最小の DCC interaction を縦に通す

依存: P4。

- [ ] Pointer 座標から Native Camera ray を生成する。
- [ ] Mesh picking と Selection 更新を Native 側で完結する。
- [ ] Selection outline または bounding box を Native／Canvas 双方に表示する。
- [ ] Viewport と Outliner の Selection を双方向同期する。
- [ ] Translate Gizmo を一軸だけ実装し、pointer down → drag → commit を通す。
- [ ] Inspector から選択 Entity の Transform を編集し、Scene と両 backend へ反映する。
- [ ] 操作中の高頻度更新と確定 command を分離し、IPC backlog が増えないことを計測する。

完了条件: load → select → translate → backend 切替 → state 維持を一つの smoke scenario として再現できる。

### P6 — macOS 検証と platform 差の記録

依存: P2。P4／P5 と並行可能だが、PoC 完了には必須。

- [ ] Intel／Apple Silicon の対象範囲を明記する。
- [ ] macOS private API を使う transparent WebView の表示、入力、resize、DPI、backend 切替を確認する。
- [ ] Windows と同じ 1080p／4K 指標を可能な範囲で計測する。
- [ ] Sleep／Wake、fullscreen、Space 移動、Retina scale 変更を確認する。
- [ ] App Store 対象外であることと、配布時の private API 制約を `docs/platform-notes.md` に記録する。

完了条件: Windows と macOS の差分、回避策、未解決事項が採否判断できる粒度で残っている。

### P7 — PoC 採否を決める

依存: P1、P2、P6。P4／P5 はテンプレート価値の評価材料だが、透明合成が不成立なら必須ではない。

- [ ] PLAN の必須／推奨成功条件を pass／fail／未検証で埋める。
- [ ] Tauri 固有制約が shell 内に局所化できたか確認する。
- [ ] 継続、Tao + Wry、Electrobun、中止を、性能・操作品質・保守量・配布制約で比較する。
- [ ] 推奨を一つに絞り、根拠、残存リスク、次の最小 milestone を Decision Record に残す。

完了条件: 未検証を成功扱いせず、次の投資判断とその根拠が文書化されている。

## クリティカルパス

`P0 baseline` → `P1 Windows 成立性` → `P2 fallback` → `P6 macOS 成立性` → `P7 採否`

P3〜P5 はテンプレートとしての設計検証。P1 で透明合成方式が不成立なら、これらへ投資する前に shell 方針を見直す。

## 次に着手する一件

P0 の build baseline 復旧から始める。まず Node 依存を `npm ci` で再現し、Rust は `cargo tree -i windows`／`cargo tree -i windows-core` で wgpu 30 と Tauri の Windows dependency 競合を特定する。依存固定を直すまで新機能へ進まない。
