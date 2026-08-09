# Hybrid Viewport PoC Status

最終更新: 2026-08-09

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
| FBX skin animation／Native Timeline playback | implemented / verified | pass (2026-08-09 test＋screenshot) | 実FBX 1 clip、約24.83秒、76 animated nodes、228 channels。Play／Pause／Seek／Loopとtimestamp付きevent同期を確認 |
| File > Import Asset | implemented / verified | pass (2026-08-09 self-test＋screenshot) | JSON手編集なしでFBX／glTF／GLBを現在Sceneへ追加。失敗時はScene／選択／保存先を保持しpath付きConsole診断 |
| Imported Scene Save／restart／Open | implemented / verified | pass (2026-08-09 self-test＋screenshot) | first Save Asで外部assetを相対化し、再起動後にasset／transform／camera／Timeline metadataを復元 |
| DOM Menu／Shortcut | implemented / verified | pass (2026-08-08 test＋self-test) | menuとshortcutは同一Action。input／modal中の抑止をunit test済み |
| Bounded Console drawer | implemented / verified | pass (2026-08-08 test＋screenshot) | scene／renderer／viewport／frontend、filter／Clear／Copy All／Auto-scroll、500 entry上限 |
| Settings modal | implemented / verified | pass (2026-08-08 test＋screenshot) | overlay、Console level／Auto-scrollを即時反映し、version付きlocalStorageへ保存 |
| Material command ack／reject | implemented / previously verified | partial | self-test値`#2DC8FF / 0.80 / 0.20`の反映はpass。rejectは未確認 |
| Native障害時の自動fallback | implemented / verified (fault injection) | pass (2026-08-09 screenshot) | 構築直後のunavailable注入でCanvas自動切替。実際の初期化例外／Device Lostは未接続 |
| Device Lost検出／fallback | implemented / verified | pass (2026-08-09 screenshot) | wgpu callbackを`RendererStatus`へ接続。再作成せずCanvasへfail-closed |
| Surface Lost／Outdated／Timeout／Occluded／Validation取得 | designed / blocked by vendor contract | unverified | contract案は`docs/SURFACE_ERROR_CONTRACT.md`。Kiss3D内部でretry後`Option::None`へ集約され、app層では正常skipとfatalを区別不能 |
| GPU OutOfMemory検出 | unimplemented | unverified | wgpu 30ではsurface取得variantではなくDevice error。Surface contractと分離する |
| fallback理由／復旧状態のUI表示 | implemented / verified | pass (2026-08-09 screenshot) | Viewport banner、Console、disabled Native action、再起動による再試行案内を確認 |
| CanvasのScene同期 | intentionally deferred | not applicable | Camera＋Safe Modeを最低保証とする |
| 1080p 60fps | implemented / regression under investigation | Native pass／Canvas fail (2026-08-09 asset-gate rerun) | 現行HEAD Native 60.644 FPS。Canvasは3 cold startsで56.793〜57.196 FPSとなり59.0 gate未達。旧baselineは60.000 FPS |
| 4K操作品質／合成コスト | external evidence waiting | blocked on hardware | 最終採否前に必要 |
| macOS透明合成／入力／切替 | external evidence waiting | blocked on hardware | 最終採否前に必要 |

## 判定ルール

- `implemented`はコードが存在することだけを示す。
- `previously verified`は過去スライスの証拠であり、現行HEADのgreenとは分ける。
- `pending`は現在の環境で再検証可能。
- `unimplemented`はテスト不足ではなく機能がまだ存在しない。
- `external evidence waiting`は手元のWindows実装を止めないが、PoC最終採否を閉じない。

## 現時点の判断

Windows上の現行スライスは継続可。Native raster viewportの部分描画、Scene JSON v1のNew／Open／Save lifecycle、BrainStem read-only Timeline、Menu／Console／Settings、構築後unavailable注入と実Device Lost callbackからのCanvas fallback、最小Sceneの1080p nominal 60 Hzまで成立した。ただし、PoC全体を完了扱いにはしない。実際のNative初期化例外、Surface acquisition error、4K、macOSが未決着である。vendorのraytrace経路は部分viewport compositeへ未接続だが、現アプリはraster `render_3d`のみを使用する。

## 2026-08-09 1080p性能baseline

- 詳細条件と再現手順: `docs/PERFORMANCE_BASELINE.md`。
- 共通条件: 物理1920x1080 target、最小Scene、debug build、60-frame warm-up後180 samples。
- pass: Native 59.971 FPS、wall p50／p95 16.638／17.494 ms、CPU render p95 17.014 ms、GPU timestamp p95 0.049 ms。
- pass: Canvas 60.000 FPS、wall p50／p95 16.700／16.800 ms、同期CPU render p95 0.200 ms。
- memoryは`tauri3d.exe`＋全WebView2子processを合算。Native Working Set平均861.3 MiB／Dedicated GPU平均1178.9 MiB、Canvas fallback 827.7 MiB／1020.4 MiB。
- 制約: Canvas WebGL GPU timestampは未取得。Canvas値はNative rendererを保持したままinactiveにする実fallback構成。複雑Scene、4K、macOS、release buildは未評価。

## 2026-08-09 FBX animation／Timeline playback証拠

- Asset: local `F:\3dcg\kokoronaki4\KimonoNaki\kimono_animation.fbx`。外部binaryと絶対pathはtracked fixture／Sceneへ追加していない。
- Screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-timeline-event-a.png` と `tauri3d-timeline-event-b.png`。2秒差で同一SHA-256、15.23秒のPause pose／playheadが固定。
- pass: FBX mesh／4-weight skin／node transform animation、source duration約24.83秒、1 clip、76 animated nodes、228 channelsをNative ViewportとTimelineへ投影。
- pass: 環境self-testでPause→50% Seek→Play→Pauseを通し、Play／Pause／Seek／Loop境界をfocused testで固定。
- performance finding: 50ms invoke pollingは100 responsesで平均86.9ms、p95 126.2ms、overlap skip 102。250ms pollingでもp95 1805.3msだったため廃止。
- current sync: Nativeがcanonical stateと採取timestampを保持し、250ms throttled Tauri eventをFrontendへpush。Frontendはsnapshot間の表示時刻だけを補間する。
- event gate: 100 eventsで平均間隔278.9ms、snapshot delivery age平均164.0ms／p95 811ms、最大event間隔2207.3ms。poll backlogは解消したが、debug＋実FBX描画中のevent-loop stallは未解消。
- GUI経路: `VITE_TIMELINE_PLAYBACK_SELF_TEST`、`VITE_TIMELINE_PLAYBACK_SYNC_SELF_TEST`、ログ、`screenshot-ui`のみ。Computer Useは未使用。

## 2026-08-09 Asset Import UI証拠

- Success screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-asset-import-fixed.png`。
- Failure screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-asset-import-failure.png`。
- pass: Built-in SceneからJSON手編集なしで実FBXをImportし、`Untitled` document、Outliner `kimono_animation-1`、Inspector、Native Viewport、1 clip／228 channels Timelineを同一操作で更新。
- pass: 壊れた`invalid-import.fbx`の期待失敗後も、実FBX表示、選択`kimono_animation-1`、`Untitled` documentを保持。Consoleへ失敗assetの絶対pathと`UnsupportedVersion`を記録。
- atomicity: animation metadata／runtime clip数の整合検査をrenderer swap前へ移し、parse／load／metadata mismatchでは現在Sceneを置換しない。
- tracked境界: 実FBXと壊れたfixtureはtracked対象へ追加していない。通常UIはFile > Import Assetのdialog filterで`.gltf`／`.glb`／`.fbx`だけを提示。
- GUI経路: `VITE_ASSET_IMPORT_SELF_TEST`、`VITE_ASSET_IMPORT_INVALID_SELF_TEST`、Console、`screenshot-ui`のみ。Computer Useは未使用。

## 2026-08-09 Imported Scene round-trip証拠

- Saved screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-asset-roundtrip-saved.png`。
- Restart／Open screenshot: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-asset-roundtrip-opened.png`。
- local saved Scene: ignored `artifacts\fbx-smoke\roundtrip\imported.scene.json`。tracked fixtureには追加していない。
- pass: Import直後のpathなし`Untitled`をSave Asし、canonical Windows `\\?\` path同士で差分化。保存JSONはFBXを相対pathで保持し、cameraとidentity instance transformを永続化。
- pass: app processを停止して再起動し、保存SceneをOpen。Outliner／Inspector／Native Viewport、FBX animation、1 clip／228 channels Timelineを復元。
- diagnostics: missing／parse／unsupported assetはpath付きerrorとしてOpen／Importをfail-closedにし、成功済みSceneと保存先を置換しない。
- GUI経路: `VITE_ASSET_IMPORT_SAVE_SELF_TEST`、`VITE_ASSET_ROUNDTRIP_OPEN_SELF_TEST`、`screenshot-ui`のみ。Computer Useは未使用。

## 2026-08-09 Asset playback vertical gate（partial）

- FBX: Import／表示／Play／Pause／Seek／Loop／Save／process再起動／Openがpass。証拠は上記FBX／Import／round-trip節。
- glTF: BrainStem Import／表示／Save／process再起動／Open／Timeline playbackがpass。1 clip、約34.88秒、57 channelsを復元。
- glTF screenshots: `C:\Users\yohaw\AppData\Local\Temp\tauri3d-gltf-import-saved.png`、`tauri3d-gltf-roundtrip-playback-a.png`、`-b.png`。Playback後18.38秒でPauseし、2秒差の2枚は同一SHA-256。
- Native 1080p: pass。180 samples、average 60.644 FPS、wall p50／p95 16.410／17.297ms、GPU p95 0.053ms。
- Canvas 1080p: fail。3 cold startsでaverage 56.993／56.793／57.196 FPS、wall p50 17.5〜17.6ms。59.0 FPS／p50 16.67ms gate未達。p95 18.1〜18.4msとCPU render p95 0.2msは範囲内。
- idle playback unavailable eventを状態遷移時1回だけへ削減したがCanvas値は改善せず、原因ではなかった。
- unresolved: Canvas nominal 60Hz回帰の切り分け、release buildでの実FBX event-loop stall再測定。したがって`ASSET-PLAYBACK-GATE-01`は完了扱いにしない。

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
