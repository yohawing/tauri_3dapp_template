# Tauri Native WGPU Hybrid Viewport PoC 企画書

## 1. 概要

Tauri 2のWeb UIと、Native Rust製のwgpuレンダラーを同一ウィンドウ内で組み合わせる、CG／DCCアプリ向けデスクトップ基盤を検証する。

通常時は、透明WebViewの背面にnative wgpuで3D Viewportを描画する。互換性問題やGPU初期化失敗時には、同じDOM領域をCanvas WebGL／WebGPU Rendererへ切り替える。

```text
Tauri Window
├─ Native wgpu Surface
│  └─ 3D Viewport
└─ Transparent WebView
   └─ React App
      ├─ Toolbar
      ├─ Outliner
      ├─ Inspector
      ├─ Timeline
      └─ ViewportHost
         ├─ Native mode: 透明領域
         └─ Canvas mode: WebGL/WebGPU Canvas
```

## 2. 背景

RustでCGツールを作る場合、既存UIフレームワークには次のトレードオフがある。

- eguiはwgpu統合が容易だが、標準デザインと大規模デスクトップUIの構築に不満がある。
- GPUIはデスクトップUIに強いが、Metal／D3D11とwgpu間のGPU Texture共有が重い。
- Bevy UIは3D統合が自然だが、DCC品質のUI部品を揃える実装量が大きい。
- Tauri＋WASM Rendererは合成が容易だが、本格CG処理では性能と機能制約がある。
- ElectrobunはNative GPU Surface統合を備えるが、Dawn／TypeScript中心となり、Rustのwgpu資産を直接使いにくい。

本PoCでは、Web UIの自由度とNative Rust／wgpuの性能を両立できるかを検証する。

## 3. 目的

### 3.1 主目的

- Reactによる自由なDCCレイアウトとnative wgpu Viewportを同一ウィンドウで成立させる。
- 3D Scene、Solver、Asset処理をNative Rust側へ集約する。
- Native RendererとCanvas Rendererを同じViewportHostから切り替えられるようにする。
- 将来、モーションリターゲット、MMD、物理オーサリング等へ再利用可能なTemplate構成を評価する。

### 3.2 検証仮説

1. 透明WebViewの背面にnative wgpuを描画しても、Windows／macOSで実用的なフレームレートを維持できる。
2. DOMで計算したViewport矩形をwgpuのViewport／Scissorへ同期できる。
3. Pointer入力をWebView側へ統一しても、Camera、Picking、Gizmo操作に支障がない。
4. Native modeとCanvas modeを、UIレイアウトを変更せず切り替えられる。
5. Tauriの既存機能を利用することで、Tao＋Wry直実装よりアプリ基盤の開発量を抑えられる。

## 4. 非目的

初期PoCでは以下を対象外とする。

- 完成版ゲームエンジン／DCCアプリの構築
- Linux／Waylandの完全対応
- 複数Window、複数Viewportの製品品質対応
- Mac App Store対応
- NativeとCanvas間のGPU Resource共有
- 完全に同等なNative／Web Renderer実装
- 高度なTimeline、Node Editor、Undo／Redoの完成
- CEF／Chromium同梱

## 5. 想定ユースケース

- モーションリターゲットツール
- MMD／キャラクターアニメーション編集
- Skeleton、Collider、Constraint編集
- 物理シミュレーションのオーサリング
- 3D Asset Viewer／Converter
- Shader、Material、Lighting Preview

## 6. UIコンセプト

```text
┌────────────────────────────────────────────┐
│ Toolbar / Menu                             │
├────────────┬──────────────────┬────────────┤
│ Outliner   │                  │ Inspector  │
│            │  ViewportHost    │            │
│            │                  │            │
├────────────┴──────────────────┴────────────┤
│ Timeline / Console                         │
└────────────────────────────────────────────┘
```

React側は1つのAppとして構築する。Dock変更、Popup、Modal、Menu等は通常のDOMとして扱う。

ViewportHostのみ、Renderer Backendに応じて表示を切り替える。

### Native mode

- ViewportHostの背景を透明にする。
- native wgpuが背面へ3D Sceneを描画する。
- DOMは入力レイヤーとして残す。

### Canvas mode

- native wgpuの描画を停止または非表示にする。
- ViewportHost内にCanvasを表示する。
- Three.js、Babylon.js、WebGL、WebGPU等で最低限のSceneを表示する。

## 7. 技術構成

### 7.1 採用候補

| 層 | 技術 |
|---|---|
| Desktop shell | Tauri 2 |
| Frontend | React + TypeScript + Vite |
| Layout | CSS Grid／Flex + Dock library候補 |
| Native Renderer | Rust + wgpu |
| Window integration | Tauri WebviewWindow + raw-window-handle |
| Native core | Pure Rust crates |
| Canvas fallback | Three.jsまたはBabylon.js |
| Serialization | serde + JSON／MessagePack候補 |
| IPC | Tauri Channel／Command／Event |
| Math | glam |
| Asset format | 初期はglTF／GLB |

### 7.2 Tauriを先に採用する理由

- Bundler、Updater、Dialog、Clipboard、Single Instance等を再実装しなくてよい。
- `WebviewWindow`からwgpu Surfaceを生成できる実例がある。
- UI入力をDOMへ統一するため、Tauriのnative入力イベント制約を回避しやすい。
- 問題が顕在化した場合、Window shellのみTao＋Wryへ置換できる構造にする。

## 8. アーキテクチャ

```text
app-desktop
├─ Tauri lifecycle
├─ Window / Surface management
├─ IPC registration
└─ Renderer mode switching

editor-web
├─ React App
├─ Dock layout
├─ ViewportHost
├─ Inspector / Outliner / Timeline
└─ Viewport input normalization

editor-protocol
├─ ViewportRect
├─ ViewportInput
├─ RendererCommand
├─ RendererStatus
└─ Serializable DTO

renderer-wgpu
├─ Surface lifecycle
├─ Camera
├─ Scene rendering
├─ Picking
├─ Gizmo
└─ Debug draw

renderer-web
├─ Canvas lifecycle
├─ Camera
├─ Minimal scene
└─ Fallback visualization

cg-core
├─ Scene model
├─ Animation
├─ Skeleton
├─ Retarget / Physics（将来）
└─ Asset loading
```

## 9. 状態管理方針

### 9.1 正本

Scene、Animation、Selection等の正本はNative Rust側に置く。

React側にはUI表示に必要なProjectionだけを送る。

```text
Native Rust: Canonical State
├─ Scene
├─ Selection
├─ Camera
├─ Playback
└─ Renderer settings

React: UI Projection
├─ Entity list
├─ Selected properties
├─ Timeline summary
└─ Status / Error
```

### 9.2 Canvas mode

Canvas Rendererは互換表示用のMirrorとする。初期PoCではNative Stateから軽量Snapshotを受け取る。

Native／CanvasでGPU Resourceは共有しない。

## 10. IPC設計

### 10.1 Viewport矩形

```rust
pub struct ViewportRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub scale_factor: f32,
}
```

React側は`ResizeObserver`と`getBoundingClientRect()`から更新する。

送信契機:

- Viewport Resize
- Dock移動
- Window Resize
- DPI変更
- Renderer mode切替

### 10.2 入力

```rust
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
    Key {
        code: String,
        pressed: bool,
        repeat: bool,
        modifiers: u16,
    },
    Focus(bool),
}
```

PointerMoveはCommand連打ではなく、Channelまたは最新値を上書きする低遅延経路を検討する。

## 11. Renderer Backend抽象化

```rust
pub enum RendererMode {
    NativeWgpu,
    Canvas,
}

pub trait ViewportBackend {
    fn set_viewport(&mut self, rect: ViewportRect);
    fn handle_input(&mut self, input: ViewportInput);
    fn set_scene_snapshot(&mut self, snapshot: SceneSnapshot);
    fn set_active(&mut self, active: bool);
}
```

実際にはRust traitをWeb側と共有しない。`editor-protocol`で同等のMessage Contractを定義する。

## 12. PoC実装範囲

### Phase 0: Skeleton

- Tauri 2＋Reactプロジェクト作成
- Window透明化
- Rust側でwgpu Surface作成
- 背景色または三角形を描画
- Web UIを前面に表示

### Phase 1: Viewport矩形同期

- ReactにViewportHostを作成
- DOM矩形をRustへ送信
- wgpuのViewport／Scissorを追従
- Window Resize、DPI変更へ対応

### Phase 2: 3D操作

- glTFモデル表示
- Orbit Camera
- Pointer／Wheel入力転送
- Ray Picking
- Selection表示
- 簡易Translate Gizmo

### Phase 3: Canvas fallback

- ViewportHostへCanvas Renderer追加
- Native／Canvas切替ボタン
- 同一Camera Parameterの同期
- 同一glTFを両Backendで表示
- Native初期化失敗時の自動Fallback

### Phase 4: DCC UI検証

- Outliner
- Inspector
- Timelineモック
- Dock Resize中のViewport追従
- Popup／ModalのViewport上表示
- File DropによるglTF読み込み

## 13. 成功条件

### 必須

- WindowsでNative wgpu＋透明WebViewが安定表示される。
- macOSでも同一構成が表示される。
- ReactのViewport Resizeへwgpu描画領域が追従する。
- Camera操作に体感上の大きな遅延がない。
- PopupやDock UIをViewport上へ重ねられる。
- Native／Canvasをアプリ再起動なしで切り替えられる。
- Native Renderer障害時にCanvasへFallbackできる。

### 推奨

- 1080pで60fpsを維持する。
- 4Kで基本UI操作が破綻しない。
- Resize中の矩形ずれが目立たない。
- Renderer停止時に無駄な連続描画を行わない。
- Surface Lostから復旧できる。

## 14. 評価項目

| 項目 | 計測内容 |
|---|---|
| 描画性能 | FPS、GPU時間、CPU frame time |
| 入力遅延 | Pointer入力からCamera反映まで |
| Resize追従 | DOM矩形とwgpu表示のずれ |
| メモリ | WebView＋wgpu＋Canvas併用時のRAM／VRAM |
| 安定性 | Resize、Sleep復帰、GPU Device Lost |
| UI互換 | WebView2、WKWebView間のCSS／入力差 |
| 配布 | Windows署名、macOS notarization |

## 15. 主なリスク

### R1. 透明WebViewのOS差

- macOSではPrivate APIが必要になる可能性が高い。
- Mac App Storeは対象外とする。
- Windows／macOS先行で評価し、Linuxは別フェーズとする。

### R2. DOM矩形とnative描画の同期ずれ

対策:

- ResizeObserverの更新をまとめる。
- Frame番号を付与する。
- 最新矩形のみをRendererへ適用する。
- Resize中は低品質描画または描画停止も検討する。

### R3. 高頻度IPC

対策:

- PointerMoveをBatch化または最新値上書きにする。
- Scene Stateを毎フレームWebへ送らない。
- Native側でCamera、Picking、Gizmoを完結する。

### R4. WebView全面合成コスト

対策:

- 半透明Blurを多用しない。
- WebView側の不要なAnimationを止める。
- NativeとCanvasを同時描画しない。
- 4Kで実測する。

### R5. Renderer二重実装

対策:

- CanvasはSafe Mode／Previewに限定する。
- Materialや高機能Gizmoの完全一致を求めない。
- Scene Snapshot形式だけ共有する。

### R6. Tauri依存の制約

対策:

- `renderer-wgpu`、`cg-core`、`editor-protocol`をTauriから独立させる。
- Window統合を`desktop-shell-tauri`へ隔離する。
- 必要ならTao＋Wry shellへ交換可能にする。

## 16. リポジトリ案

```text
tauri-wgpu-editor-template/
├─ Cargo.toml
├─ crates/
│  ├─ cg-core/
│  ├─ editor-protocol/
│  ├─ renderer-wgpu/
│  └─ desktop-shell-tauri/
├─ src-tauri/
│  ├─ src/
│  │  ├─ main.rs
│  │  ├─ surface.rs
│  │  ├─ renderer_loop.rs
│  │  ├─ ipc.rs
│  │  └─ fallback.rs
│  └─ tauri.conf.json
├─ web/
│  ├─ src/
│  │  ├─ App.tsx
│  │  ├─ viewport/
│  │  │  ├─ ViewportHost.tsx
│  │  │  ├─ nativeBackend.ts
│  │  │  ├─ canvasBackend.ts
│  │  │  └─ input.ts
│  │  ├─ panels/
│  │  └─ store/
│  └─ package.json
├─ assets/
│  └─ test.glb
└─ docs/
   ├─ architecture.md
   ├─ platform-notes.md
   └─ protocol.md
```

## 17. 初期タスク

1. Tauri 2最新安定版で透明WebView＋wgpu Surfaceを再現する。
2. `tauri-wgpu-cam`相当の最小描画を最新wgpuへ更新する。
3. React ViewportHostの矩形をRustへ送る。
4. Scissorで中央領域だけ描画する。
5. DOM Pointer EventでOrbit Cameraを操作する。
6. Surface Lost／Resize／DPIのログを整備する。
7. Canvas Rendererを追加して切替可能にする。
8. Windows／macOSの挙動差を記録する。

## 18. 採否判断ゲート

PoC完了時に次を判断する。

### 継続

- 透明合成が安定している。
- 入力遅延が許容範囲。
- Dock Resizeのずれを抑制できる。
- Tauriの制約が局所的である。

### Tao＋Wryへ移行

- TauriのWindow／Event制約がRenderer実装を妨げる。
- Surface lifecycleへ必要なアクセスが不足する。
- 複数Window／native入力が必須になる。

### Electrobunへ移行

- Rustのwgpu直接利用より、Web UIとGPU Surfaceの完成度を優先する。
- Dawn C APIまたは別Renderer実装を許容できる。
- CEF同梱によるWeb実行環境統一が重要になる。

### 中止

- OSごとの透明合成差が大きすぎる。
- 4K環境で合成コストが許容できない。
- Input／Resize同期が操作品質を満たさない。

## 19. 将来拡張

- 複数Viewport
- 複数Window
- Timeline／Dope Sheet
- Node Editor
- Undo／Redo Command System
- PMX／VMD Loader
- Retarget Solver
- Skeleton／Collider Editor
- GPU Physics
- Renderer Plugin API
- CEF backend
- Tao＋Wry shell
- Linux／Wayland対応

## 20. 企画上の結論

本PoCでは、Tauriを製品シェルとして利用しつつ、Renderer、Scene、SolverをNative Rustへ集約する。

最初からTao＋Wryを全面採用せず、Tauriで透明Overlay方式の成立性を短期間で確認する。Tauri固有の制約へ当たった場合に備え、CGコアとRendererを独立crateに分離し、Shell交換可能な構造を維持する。

Native wgpuを主経路、Canvas RendererをSafe Mode／互換経路とする。両者の完全な機能一致は求めず、UIレイアウトと入力Contractを共通化する。
