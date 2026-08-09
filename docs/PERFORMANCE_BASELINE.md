# Windows 1080p Performance Baseline

最終更新: 2026-08-09

## 判定条件

- 物理 render target: `1920x1080`。DOM Viewportの表示寸法やOSのDPRには依存させない。
- Scene: 起動時のCube、Grid、Axes、Key Light。
- build: `tauri dev`（debug）。各backendを別プロセスでcold startする。
- warm-up: 60 frames。続く180 framesを集計する。
- nominal 60 Hz pass: average FPSが59.0以上、frame wall p50が16.67 ms以下、p95が18.5 ms以下。
- Native CPU timeはKiss3D `render_3d`全体で、present／vsync待ちを含む。GPU timeはwgpu timestamp query対象passの合計。
- Canvas CPU timeは`WebGLRenderer.render`の同期呼び出し時間。WebGL GPU timestampは未実装なので判定に使わない。
- RAMは`tauri3d.exe`と全WebView2子processのWorking Set／Private Bytes合計。GPU memoryは同じprocess treeに対するWindows `GPU Process Memory` counterのDedicated／Shared Usage合計。
- memoryはframe集計完了後、500 ms間隔の5 samplesの平均／最大。Windows counter値はprocess committed usageの診断値であり、asset単位のallocator実使用量ではない。

環境変数:

```powershell
$env:TAURI3D_PERF_TARGET='1920x1080'
$env:TAURI3D_PERF_SAMPLE_FRAMES='180'

# Canvasのみ追加
$env:VITE_PERF_TARGET='1920x1080'
$env:VITE_PERF_SAMPLE_FRAMES='180'
$env:VITE_PERF_BACKEND='canvas'

npm run tauri dev
```

完了時にホストlogへ1行の`[perf]` JSONが出る。通常起動では計測、target override、追加logのいずれも有効にならない。

## 2026-08-09 baseline

環境: Windows 11 Home build 26200、Ryzen 9 7900X、NVIDIA GeForce RTX 5070 Ti driver 32.0.15.9579、WebView2 151.0.4129.72。

| backend | average FPS | wall p50 / p95 / p99 | CPU render p50 / p95 / p99 | GPU p95 | 判定 |
|---|---:|---:|---:|---:|---|
| Native wgpu | 59.971 | 16.638 / 17.494 / 18.211 ms | 16.359 / 17.014 / 17.426 ms | 0.049 ms | pass |
| Canvas WebGL | 60.000 | 16.700 / 16.800 / 16.800 ms | 0.100 / 0.200 / 0.300 ms | unavailable | pass（GPU time除外） |

| backend | Working Set avg / max | Private Bytes avg / max | Dedicated GPU avg / max | Shared GPU avg / max |
|---|---:|---:|---:|---:|
| Native wgpu | 861.3 / 864.9 MiB | 1733.8 / 1737.6 MiB | 1178.9 / 1179.1 MiB | 150.1 / 150.7 MiB |
| Canvas fallback | 827.7 / 828.5 MiB | 1530.3 / 1531.0 MiB | 1020.4 / 1020.4 MiB | 148.4 / 148.4 MiB |

Canvas fallbackはCanvasだけのisolated値ではない。再切替とTLS破棄順序の安全性のためNative rendererを保持し、描画のみ停止した実運用構成の値である。

## 解釈と境界

- 推奨条件の1080p nominal 60 Hzは、このWindows機と最小Sceneでは両backendともpass。
- NativeのCPU renderはpresent待ちに支配されるため、GPU p95との単純比較でCPU描画負荷とは判定しない。
- CanvasのWebGL GPU timeは未取得。FPS判定はwall timeで成立するが、backend間のGPU cost比較は未検証。
- Asset playback実FBXのCanvas回帰では、追加RAF計測（callback delay／browser timestamp interval）をreleaseへ導入したが、shell起動時のWebView2可視性・foreground条件を固定できず、3 cold startsの再測定は未成立。Win32 foreground handle一致時もRAF timestamp／callback delay p95が約1000／1013ms、同期`WebGLRenderer.render` p95は0.2msだったため、製品側のframe pacing修正は追加していない。
- このbaselineは複雑なasset、animation、4K、macOS、release buildの性能を保証しない。
