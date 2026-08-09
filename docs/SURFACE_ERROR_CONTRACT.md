# Surface Acquisition Contract Proposal

最終更新: 2026-08-09

状態: design only。`vendor/kiss3d-toon`の既存dirty viewport WIPへは未実装。

## 現状の問題

`WgpuCanvas::get_current_texture()`はwgpu 30の取得結果を`Option<SurfaceTexture>`へ潰している。`Outdated`／`Lost`では同じ`Surface`を再configureして1回retryし、retry失敗、`Timeout`、`Occluded`、`Validation`、surface不在をすべて`None`にする。

`Window::acquire_next_frame()`も`None`をstartup待機または通常frame skipとして扱い、最上位の`render_3d() -> bool`はwindowを継続するかだけを返す。このためhost appは、最小化等の正常なskipとCanvas fallbackが必要なsurface喪失を区別できない。

wgpu 30の`CurrentSurfaceTexture`は以下であり、surface取得結果に`OutOfMemory`は存在しない。

- `Success(SurfaceTexture)`
- `Suboptimal(SurfaceTexture)`
- `Timeout`
- `Occluded`
- `Outdated`
- `Lost`
- `Validation`

OOMは`wgpu::Error::OutOfMemory`としてDevice error scope／uncaptured error側で扱う。Surface contractへ架空variantを追加しない。

## 提案する二層contract

surface textureを保持する内部結果と、1 frame完了後にhostへ返すpublic結果を分ける。

```rust
enum SurfaceAcquire {
    Ready {
        texture: wgpu::SurfaceTexture,
        suboptimal: bool,
    },
    Skip(SurfaceSkipReason),
    Unavailable(SurfaceUnavailableReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceSkipReason {
    Timeout,
    Occluded,
    OutdatedAfterReconfigure,
    ZeroSizedSurface,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceUnavailableReason {
    Lost,
    Validation,
    MissingSurface,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderFrameStatus {
    Presented { suboptimal: bool },
    Skipped(SurfaceSkipReason),
    SurfaceUnavailable(SurfaceUnavailableReason),
    Closed,
}
```

`ZeroSizedSurface`は取得前にsurface dimensionsから判定する。DOM Viewportがzero-size／fully clippedのときに透明領域をclearしてpresentする既存経路はsurface failureではなく、`Presented`のままにする。

## variantごとの処理

| wgpu結果 | vendor処理 | host結果 |
|---|---|---|
| `Success` | そのframeを描画 | `Presented { suboptimal: false }` |
| `Suboptimal` | そのframeを描画し、present後の再configureを予約 | `Presented { suboptimal: true }` |
| `Timeout` | retryせず次frameへ | `Skipped(Timeout)` |
| `Occluded` | retryせず次frameへ | `Skipped(Occluded)` |
| `Outdated` | configureして1回だけretry | retry成功なら`Presented`、再度Outdatedなら`Skipped(OutdatedAfterReconfigure)` |
| `Lost` | 同じsurfaceのconfigure retryをしない | `SurfaceUnavailable(Lost)` |
| `Validation` | retryしない | `SurfaceUnavailable(Validation)` |
| visible canvasにsurfaceなし | retryしない | `SurfaceUnavailable(MissingSurface)` |

wgpu 30は`Lost`にsurface再作成を要求している。同じsurfaceへ`configure`する現行処理は`Outdated`には妥当だが、`Lost`の復旧にはならない。埋め込み用surface targetを安全に再生成できるownershipがvendorにない間は、hostへunavailableを返してCanvasへfail-closedする。

## public APIの互換境界

既存利用者の`while window.render_3d(...).await`を壊さない。

```rust
pub async fn render_3d_status(...) -> RenderFrameStatus;

pub async fn render_3d(...) -> bool {
    !matches!(self.render_3d_status(...).await, RenderFrameStatus::Closed)
}
```

同じstatus版を2D、chain、汎用`render`へ一度に広げると差分が大きくなる。最初は内部`render_single_frame_status`と、root appが使う`render_3d_status`だけを追加し、既存wrapperはstatusをboolへ射影する。raytrace経路はroot appの現行非利用経路なので、このsliceの完了条件に含めない。

## root appの扱い

- `Presented`: 現状どおり継続。
- `Skipped`: Nativeをavailable／activeのまま維持する。連続logを出さず、必要ならreason別counterだけ更新する。
- `SurfaceUnavailable`: `RendererActive=false`、`RendererStatus::mark_unavailable`、`renderer-status-changed` eventでCanvasへfallback。
- `Closed`: Tauriのwindow lifecycleへ委ねる。
- `wgpu::Error::OutOfMemory`: Surface statusではなく、Device error callbackの別sliceでfail-closedに扱う。

## 実装順と検証

1. vendor dirty viewport WIPのownerと統合境界を確認する。
2. `wgpu_canvas.rs`でraw variantを保持する内部取得結果を導入する。
3. `rendering.rs`へ`RenderFrameStatus`を通し、既存bool APIをwrapperとして保持する。
4. root `Renderer::render()`からstatusを返し、Tauri main loopでunavailableのみfallbackへ接続する。
5. pure mapping unit testで全wgpu variant、Outdatedのretry上限、Lostでconfigureしないことを固定する。
6. root focused testで`Skipped`がavailableを維持し、`SurfaceUnavailable`だけがinactive＋event対象になることを固定する。
7. fault injectionは`Timeout`／`Occluded`がfallbackしないこと、`Lost`／`Validation`がfallbackすることを確認する。実surface喪失の証拠とは区別する。

## 非目標

- このdesign documentだけでSurface Lost復旧またはfallback実装済みとは宣言しない。
- dirty vendor WIPをroot commitへ混ぜない。
- Surface Lost時のin-place surface再生成、Device再生成、OOM復旧を同じsliceへ含めない。
- minimize／occlusionをfatal扱いしない。
