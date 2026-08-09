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
| Scene File New／Open／Save lifecycle | implemented / verified | pass (2026-08-09 test＋screenshot) | Save As後の失敗Openで現Sceneを保持し、通常Save、Newまで確認。relative asset rebaseもfocused test済み |
| BrainStem read-only Timeline | implemented / verified | pass (2026-08-08 test＋screenshot) | 1 clip、約34.88秒、57 channels、74613 keys、LINEARを検証。visible range＋pixel density描画 |
| DOM Menu／Shortcut | implemented / verified | pass (2026-08-08 test＋self-test) | menuとshortcutは同一Action。input／modal中の抑止をunit test済み |
| Bounded Console drawer | implemented / verified | pass (2026-08-08 test＋screenshot) | scene／renderer／viewport／frontend、filter／Clear／Copy All／Auto-scroll、500 entry上限 |
| Settings modal | implemented / verified | pass (2026-08-08 test＋screenshot) | overlay、Console level／Auto-scrollを即時反映し、version付きlocalStorageへ保存 |
| Material command ack／reject | implemented / previously verified | partial | self-test値`#2DC8FF / 0.80 / 0.20`の反映はpass。rejectは未確認 |
| Native障害時の自動fallback | implemented / verified (fault injection) | pass (2026-08-09 screenshot) | 構築直後のunavailable注入でCanvas自動切替。実際の初期化例外／Device Lostは未接続 |
| Device Lost検出／fallback | implemented / verified | pass (2026-08-09 screenshot) | wgpu callbackを`RendererStatus`へ接続。再作成せずCanvasへfail-closed |
| Surface Lost／Outdated／Timeout／OutOfMemory取得 | blocked by vendor contract | unverified | Kiss3D内部でretry後`Option::None`へ集約され、app層では最小化frame skipと区別不能 |
| fallback理由／復旧状態のUI表示 | implemented / verified | pass (2026-08-09 screenshot) | Viewport banner、Console、disabled Native action、再起動による再試行案内を確認 |
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

Windows上の現行スライスは継続可。Native raster viewportの部分描画、Scene JSON v1のNew／Open／Save lifecycle、BrainStem read-only Timeline、Menu／Console／Settings、構築後unavailable注入と実Device Lost callbackからのCanvas fallbackまで成立した。ただし、PoC全体を完了扱いにはしない。実際のNative初期化例外、Surface acquisition error、4K、macOSが未決着である。vendorのraytrace経路は部分viewport compositeへ未接続だが、現アプリはraster `render_3d`のみを使用する。

## 2026-08-09 Device Lost callback証拠

- Device Lost screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-device-lost-gate-20260809\device-lost.png`。
- Recovery screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-device-lost-gate-20260809\recovered-native.png`。
- pass: `TAURI3D_FORCE_DEVICE_LOST=1`でwgpu deviceを実際にdestroyし、`DeviceLostReason::Destroyed` callbackを取得。
- pass: callbackがNative描画をfail-closedで停止し、Tauri event経由でCanvasへ自動切替。Viewport bannerとConsoleに`wgpu device lost (Destroyed)`を表示。
- pass: 環境変数なしの再起動でNative cube、Grid、Timeline、Viewport rectが復旧。
- blocked: Surface `Lost／Outdated`はvendor内で再configure＋1回retryされ、その後の全surface acquisition errorは`Option::None`へ集約される。`render_3d`の`bool`はwindow継続だけを表すためroot appでは分類不能。
- GUI経路: 実Device Lost注入、Tauri event、`screenshot-ui`のみ。Computer Useは未使用。

## 2026-08-09 Renderer fallback証拠

- Fault screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-renderer-fallback-gate-20260809\fallback.png`。
- Recovery screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-renderer-fallback-gate-20260809\recovered-native.png`。
- pass: `TAURI3D_FORCE_NATIVE_FAILURE=1`でNative renderer構築直後にunavailableを注入し、描画をinactiveにしたままCanvasへ自動切替。
- pass: Canvas cube、disabled Native action、Canvas選択状態、Viewport banner、Consoleのfallback理由、fault解除再起動の案内を確認。
- pass: fault解除後の再起動でNative cube、Grid、Outliner／Inspector、Timeline、Viewport rect `x=220 y=24 w=780 h=536`が復旧。
- runtime制約: 構築済みKiss3D rendererをsetup中にdropするとtexture managerのTLS破棄順序でpanicするため、fallback中もevent-loop threadに保持し、描画だけ停止する。
- 非目標: この証拠は実際のwgpu初期化例外、Surface Lost、Device Lostの検出／復旧を証明しない。
- GUI経路: fault injection、ログ、`screenshot-ui`のみ。Computer Useは未使用。

## 2026-08-09 Scene File lifecycle証拠

- Screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-scene-file-gate-20260809\final.png`。
- 保存artifact: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-scene-file-gate-20260809\saved.scene.json`。
- pass: `box.scene.json` Open、Save As、存在しないSceneの期待どおりのOpen失敗、失敗後の通常Save、New `Untitled`。
- pass: 失敗Open後も保存先とdocumentを保持し、通常Saveが同じ`BoxTextured Scene`を保存した。
- pass: Save As時のrelative asset rebase、通常Saveのcamera永続化、書き込み失敗時のpath／revision保持をRust focused testで確認。
- pass: 最終Native Viewport、Outliner／Inspector、Console、Viewport rect `x=220 y=24 w=780 h=536`の整合。
- GUI経路: `VITE_FILE_SELF_TEST_OPEN`、`VITE_FILE_SELF_TEST_SAVE`、`VITE_FILE_SELF_TEST_INVALID_OPEN`と`screenshot-ui`のみ。Computer Useは未使用。

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
