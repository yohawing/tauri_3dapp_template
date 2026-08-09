# Tauri Native WGPU Hybrid Viewport PoC

Tauri + wgpu renderer でつくるDCC／CGアプリ基盤のテンプレートです

## 必要環境

- Windows 10／11（現在の主検証環境）
- Node.js: Vite 7を実行可能な版（20.19以上、または22.12以上）
- Rust stableとCargo
- WindowsではVisual Studio Build ToolsのDesktop development with C++ workload
- WebView2 Runtime

## セットアップと起動

PowerShellでリポジトリrootから実行します。

```powershell
git submodule update --init --recursive
npm ci
npm run tauri dev
```

Native rendererは`vendor/kiss3d-toon`のforkをpath dependencyとして使用します。このforkではTauriが所有するwindow／event loopへKiss3dを埋め込むためのAPIと、アプリ本体に合わせたwgpu 30対応を追加しています。forkを更新する場合は、先にsubmodule側の変更をcommit／pushし、その後このリポジトリでsubmodule pointerを更新してください。

Frontendだけをブラウザーで確認する場合:

```powershell
npm run dev
```

ブラウザー単体ではTauri IPCが存在しないため、native rendererやnative Camera操作は動きません。Canvas modeとUI shellの確認用途です。

## 操作

Native mode:

- Drag: Orbit
- Shift + Drag: Pan
- Wheel: Zoom

RendererメニューでNative／Canvasを切り替えます。Canvas modeではThree.jsのOrbitControlsが入力を処理します。

Scene file:

- サンプル: `examples/box.scene.json`、`examples/brainstem.scene.json`
- File > New: 空の`Untitled` Sceneを作成
- File > Open…: `.scene.json`を検証して現在のNative Sceneへ読み込み
- File > Save／Save As…: 現在のCameraを含めて保存
- Shortcuts: `Ctrl+N`、`Ctrl+O`、`Ctrl+S`、`Ctrl+Shift+S`（macOSはCommand）

## 検証

```powershell
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

### 開発用診断フラグ

起動前に必要な環境変数を設定します。

```powershell
$env:TAURI3D_LOG_VIEWPORT_RECT = "1"
$env:VITE_INPUT_SELF_TEST = "1"
$env:VITE_BACKEND_SELF_TEST = "1"
$env:VITE_DOCK_SELF_TEST = "1"
$env:TAURI3D_FORCE_NATIVE_FAILURE = "1"
$env:TAURI3D_FORCE_DEVICE_LOST = "1"
npm run tauri dev
```

| 変数 | 内容 |
|---|---|
| `TAURI3D_LOG_VIEWPORT_RECT` | Rust側でViewport矩形変更を記録 |
| `VITE_INPUT_SELF_TEST` | Pointer／Wheelのscripted入力を一度実行 |
| `VITE_BACKEND_SELF_TEST` | Native→Canvas→Native切替を一度実行 |
| `VITE_DOCK_SELF_TEST` | panel move、Inspector非表示、layout resetを順に実行 |
| `TAURI3D_FORCE_NATIVE_FAILURE` | Native renderer構築直後にunavailableを注入し、自動Canvas fallbackと復旧案内を検証 |
| `TAURI3D_FORCE_DEVICE_LOST` | wgpu deviceを起動後にdestroyし、実Device Lost callbackからCanvas fallbackまでを検証 |

通常起動へ戻す場合はPowerShell sessionを閉じるか、設定した環境変数を削除してください。

## 設計上の境界

- Scene、Selection、Cameraなどの正本は最終的にNative Rust側へ置く。
- ReactはUI Projectionと入力layerを担当する。
- Canvas backendはSafe Mode／Previewであり、Nativeとの完全な描画一致を目標にしない。
- NativeとCanvasでGPU resourceを共有しない。
- `ViewportHost`のDOM contractを共通化し、Renderer backendでUI layoutを変えない。
- 将来のshell交換に備え、core／renderer／protocolをTauri固有処理から分離する。

## 関連文書

- [`TODO.md`](TODO.md): 依存順の実行queueと完了条件
- [`docs/IDEA.md`](docs/IDEA.md): PoC企画書
- [`docs/SCENE_FORMAT.md`](docs/SCENE_FORMAT.md): version付きScene JSONとローカルAsset pathの最小契約
- [`docs/POC_STATUS.md`](docs/POC_STATUS.md): 実装、検証、未実装、外部証拠待ちを分けたPoC台帳
- [`docs/TIMELINE_PLAN.md`](docs/TIMELINE_PLAN.md): Temporal Editor subsystemの正式実装計画
- [`docs/ui-research.md`](docs/ui-research.md): DCC UI library調査

## License

MIT
