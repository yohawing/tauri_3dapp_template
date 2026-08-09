# Surface Acquisition Contract

最終更新: 2026-08-09

状態: vendor実装済み（commit `6b70528`）＋root lifecycle接続済み。実Surface Lost発生の実機証拠は未取得。

## 現状の問題

旧実装では`WgpuCanvas::get_current_texture()`がwgpu 30の取得結果を`Option<SurfaceTexture>`へ潰していた。現行vendor実装はraw outcomeを内部statusへ保持し、`Outdated`のみ同じ`Surface`を再configureして1回retryする。

status経路の`Window::render_3d_status()`は一回の取得結果をそのまま返す。旧bool経路のprivate startup待機は互換用に残るが、hostへは`RenderFrameStatus`を通じて正常skipとCanvas fallbackが必要なsurface喪失を区別する。

wgpu 30の`CurrentSurfaceTexture`は以下であり、surface取得結果に`OutOfMemory`は存在しない。

- `Success(SurfaceTexture)`
- `Suboptimal(SurfaceTexture)`
- `Timeout`
- `Occluded`
- `Outdated`
- `Lost`
- `Validation`

OOMは`wgpu::Error::OutOfMemory`としてDevice error scope／uncaptured error側で扱う。Surface contractへ架空variantを追加しない。

## 二層contract

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

`rt_switcher` feature有効時のみ、既存bool `render_3d`はraytrace dispatchを維持する。root appはraster `render_3d_status`を使用し、status APIをraytrace／2D／chainへ拡張しない。

同じstatus版を2D、chain、汎用`render`へ一度に広げると差分が大きくなる。内部`render_single_frame_status`と、root appが使う`render_3d_status`だけを公開し、既存wrapperはstatusをboolへ射影する。

## root appの扱い

- `Presented`: 現状どおり継続。
- `Skipped`: Nativeをavailable／activeのまま維持する。連続logを出さず、必要ならreason別counterだけ更新する。
- `SurfaceUnavailable`: `RendererActive=false`をatomic swapし、`RendererStatusStore::mark_unavailable_once`、reason付き`renderer-status-changed` eventでCanvasへfallback。反復statusでは再通知しない。
- `Closed`: Tauriのwindow lifecycleへ委ねる。
- `wgpu::Error::OutOfMemory`: Surface statusではなく、Device error callbackの別sliceでfail-closedに扱う。

## 実装順と検証

1. vendor dirty viewport WIPのownerと統合境界を確認する。 (完了)
2. `wgpu_canvas.rs`でraw variantを保持する内部取得結果を導入する。 (完了)
3. `rendering.rs`へ`RenderFrameStatus`を通し、既存bool APIをwrapperとして保持する。 (完了)
4. root `Renderer::render()`からstatusを返し、Tauri main loopでunavailableのみfallbackへ接続する。 (完了)
5. pure mapping unit testで全wgpu variant、Outdatedのretry上限、Lostでconfigureしないことを固定する。 (完了)
6. root focused testで`Skipped`がavailableを維持し、`SurfaceUnavailable`だけがinactive＋event対象になることを固定する。 (完了)
7. fault injectionは`Timeout`／`Occluded`がfallbackしないこと、`Lost`／`Validation`／`MissingSurface`がfallbackすることを確認する。実surface喪失の証拠とは区別する。 (完了: focused tests。実app envは未実施)

## 非目標

- このsliceはSurface Lost時のsurface再生成・実機復旧を実装せず、fault injectionを実Surface Lost証拠として扱わない。
- dirty vendor WIPをroot commitへ混ぜない。
- Surface Lost時のin-place surface再生成、Device再生成、OOM復旧を同じsliceへ含めない。
- minimize／occlusionをfatal扱いしない。
