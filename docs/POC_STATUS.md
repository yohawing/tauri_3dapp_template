# Hybrid Viewport PoC Status

最終更新: 2026-08-08

この表は実装、設計、現行HEADでの検証、外部実機待ちを混同しないための台帳である。過去のgreenは参考情報であり、次スライス開始時に現行HEADで再確認する。

| 評価項目 | 現在地 | 現行HEAD再検証 | 備考 |
|---|---|---|---|
| Windows Native renderer＋透明WebView | implemented / previously verified | pass (2026-08-08 screenshot) | Native cubeが透明Viewport内だけに表示され、DOM panelが前面に重なる |
| DOM Viewport矩形通知 | implemented / verified | pass (2026-08-08 self-test) | ResizeObserver→IPC→Rust保存、DPR 1.5、move／resize／reset後のrect更新まで確認 |
| Native viewport／Scissor適用 | implemented / verified | pass (2026-08-08 screenshot＋log) | DOM rectをDPR変換・clampし、raster offscreen結果を同じviewportへ部分composite。負origin／zero-sizeもunit test済み |
| Dock resize／moveの実描画追従 | implemented / verified | pass (2026-08-08 self-test) | `VITE_DOCK_SELF_TEST`でresize／move／reset後の四辺、中心、aspectとrect logの一致を確認 |
| Orbit／Pan／Zoom入力 | implemented / verified | pass (2026-08-08 self-test) | `VITE_INPUT_SELF_TEST`でOrbit、Wheel Zoom、Shift+Drag Panを実行 |
| Popup／DOM panelの重なり | implemented / verified | pass (2026-08-08 screenshot) | View／Renderer popup、Settings modal、Outliner／Inspector／Timeline／ConsoleがNative描画より前面 |
| Native→Canvas→Native手動切替 | implemented / verified | pass (2026-08-08 self-test) | `VITE_BACKEND_SELF_TEST`の時系列captureでnative→canvas→nativeを確認 |
| Camera continuity | implemented / verified | pass (2026-08-08 self-test) | Scene cameraから開始し、切替中の入力後もmanaged stateでNativeへ復帰 |
| inactive backendの描画停止 | implemented / verified | pass (2026-08-08 self-test) | backend切替の有限状態とNative描画停止／再開をself-test logで確認。GPU計測は非目標 |
| Rust Scene Projection／Selection | implemented / verified | pass (2026-08-08 screenshot) | built-in CubeとScene由来`box-instance`のID／label／Transformを確認 |
| BrainStem read-only Timeline | implemented / verified | pass (2026-08-08 test＋screenshot) | 1 clip、約34.88秒、57 channels、74613 keys、LINEARを検証。visible range＋pixel density描画 |
| DOM Menu／Shortcut | implemented / verified | pass (2026-08-08 test＋self-test) | menuとshortcutは同一Action。input／modal中の抑止をunit test済み |
| Bounded Console drawer | implemented / verified | pass (2026-08-08 test＋screenshot) | scene／renderer／viewport／frontend、filter／Clear／Copy All／Auto-scroll、500 entry上限 |
| Settings modal | implemented / verified | pass (2026-08-08 test＋screenshot) | overlay、Console level／Auto-scrollを即時反映し、version付きlocalStorageへ保存 |
| Material command ack／reject | implemented / previously verified | partial | self-test値`#2DC8FF / 0.80 / 0.20`の反映はpass。rejectは未確認 |
| Native初期化失敗時の自動fallback | unimplemented | not applicable | lifecycle設計とfault injectionが必要 |
| Surface／Device Lost復旧 | unimplemented / unverified | not applicable | failure取得範囲を先に確認する |
| fallback理由／復旧状態のUI表示 | unimplemented | not applicable | `RendererStatus`が必要 |
| CanvasのScene同期 | intentionally deferred | not applicable | Camera＋Safe Modeを最低保証とする |
| 1080p 60fps | unverified | pending | 計測条件を固定する |
| 4K操作品質／合成コスト | external evidence waiting | blocked on hardware | 最終採否前に必要 |
| macOS透明合成／入力／切替 | external evidence waiting | blocked on hardware | 最終採否前に必要 |

## 判定ルール

- `implemented`はコードが存在することだけを示す。
- `previously verified`は過去スライスの証拠であり、現行HEADのgreenとは分ける。
- `pending`は現在の環境で再検証可能。
- `unimplemented`はテスト不足ではなく機能がまだ存在しない。
- `external evidence waiting`は手元のWindows実装を止めないが、PoC最終採否を閉じない。

## 現時点の判断

Windows上の現行スライスは継続可。Native raster viewportの部分描画、Scene JSON v1、BrainStem read-only Timeline、Menu／Console／Settingsまで成立した。ただし、PoC全体を完了扱いにはしない。Native障害時の自動fallback、Surface lifecycle、4K、macOSが未決着である。vendorのraytrace経路は部分viewport compositeへ未接続だが、現アプリはraster `render_3d`のみを使用する。

## 2026-08-08 現行HEADのWindows証拠

- Screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-baseline-20260808\settled-final.png`
- 実行環境: 1924×1247、DPR 1.50、Native wgpu。
- pass: 透明Viewport内のCube、DOM Outliner／Inspector／Timeline、静的Viewport rect `x=220 y=40 w=780 h=520`、Material self-test値の反映。
- 追加Screenshot directory: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-scene-gate-20260808`。
- pass: built-in Cube互換、BoxTextured glTF sample、Scene名／instance ID／Transform Projection、不正Sceneのpath付き診断、Dock move／resize／reset、Orbit／Zoom／Pan、Native→Canvas→Native camera handoff。
- fail: なし。
- pending: Material reject、1080p 60fps、Native障害fallback、Surface／Device Lost復旧。Scene JSON v1のWindows完了条件には含めない。

## 2026-08-08 UI／BrainStem追加証拠

- Viewport screenshot directory: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-viewport-gate-20260808`。
- pass: dock resize `w=780→620`、dock move `x=220→0`、reset、window resize、DPR 1.50、popup。rect logとNative描画境界が一致した。
- BrainStem／Console／Settings screenshot directory: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-brainstem-selftest-20260808`。
- pass: BrainStem Scene Tree／Inspector／Native Viewport、Timeline zoom／horizontal scroll、57 channel／74613 keyのdensity表示、Console drawerによるViewport高 `528→377` の同期、Canvas→Native復帰、Settings modal。
- CLI gate: `npm run build`、Vitest 25 tests、`cargo fmt --check`、`cargo check --locked`、Rust 24 testsがpass。
- GUI経路: `VITE_TIMELINE_SELF_TEST`、`VITE_SHELL_SELF_TEST`、`VITE_BACKEND_SELF_TEST`、`TAURI3D_LOG_VIEWPORT_RECT`と`screenshot-ui`のみ。Computer Useは未使用。
- 制約: Scene startup parse／asset failureはfail-closedで、アプリ内Consoleではなく起動stderrへ出る。起動後のscene／renderer／viewport／frontend diagnosticはConsoleで分離表示する。
