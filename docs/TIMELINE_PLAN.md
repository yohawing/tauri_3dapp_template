# Temporal Editor 統合実装計画

Status: In Progress（frontend read-only UI／表示契約の初版まで実装。Rust canonical model／IPCは未着手）

## 1. Summary

現在のTauriアプリで動く最小縦切りを優先しながら、CG・映像・音声用途へ再利用できるTemporal Editor基盤を構築する。

- Rust App Coreがcanonical `TemporalDocument`、validation、Command実行、Undo／Redo Historyを所有する。
- FrontendはPure TypeScript Timeline Engine、Canvas renderer、React adapter、Rust stateのProjection cacheを持つ。
- 最初は現package内を`core / canvas / react / adapters`へ論理分割し、standalone利用を実証してからworkspace packageへ抽出する。
- Phase 0で10万Key benchmarkを作る。100万Keyは縦切り完成後のstress gateとする。
- `Marker ≠ Event`、`Group ≠ Binding`、`Clip ≠ Cue`、値ChannelとEvent評価の分離をmodelとtestで固定する。

### 1.1 成功条件

- 同じEngineをSeconds domainとTick domainで利用できる。
- 保存時間、表示形式、編集grid／snapを独立して差し替えられる。
- Timelineはserializableな編集意図を発行し、Document更新とHistoryはRust App Coreが所有する。
- Dragは`begin → preview* → commit`または`cancel`の一Transactionになり、Historyはcommit一件になる。
- global keybindはAppが所有し、Timelineは意味的Actionだけを公開する。
- pointermove中のpan／zoom／scrub／drag preview／hit testでReact renderやRust IPCを発生させない。
- React adapterとstandalone adapterが同じEngine／Canvas rendererを共有する。
- Tauri統合時もRust canonical stateを維持し、Frontendに第二の正本を作らない。

### 1.2 初期スコープ外

- Graph Editor、Audio／Video編集、Subsequence、非線形retimingの完成
- CRDT、Worker／OffscreenCanvas／WebGPUの先行導入
- Timeline Core内部のHistory、global keybind、外部副作用実行
- 公開Plugin APIの早期固定
- NLE／DAW製品相当の編集機能

## 2. Architecture

```text
Rust Application Core
├─ TemporalDocument (canonical state)
├─ Validation
├─ Value / Event evaluation
├─ Command execution
└─ Undo / Redo History
          │
          │ revision付きProjection snapshot
          ▼
Frontend Projection Cache
└─ TimelineDataSource (sync read + subscribe)
          │
          ▼
Pure TypeScript Timeline Engine
├─ TimeDomain / TimeFormatter / SnapStrategy
├─ View state (zoom / pan / row expansion)
├─ Selection adapter
├─ Interaction state machine
├─ Hit test / Snap / Layout
├─ Semantic Actions
└─ TimelineEditEvent generation
          │
          ├─ Imperative Canvas Renderer
          ├─ React Adapter
          └─ Standalone Adapter
          │
          ▼
TimelineCommandSink
└─ App Command Busへbegin / preview / commit / cancelを返す
```

重要な境界:

- Frontend DataSourceはlocal projection cacheを同期readする。描画やhit test中にTauri IPC queryを行わない。
- RustからFrontendへはrevision付きsnapshotを送り、Frontend cacheを置き換える。初期版ではdelta同期を実装しない。
- TimelineはDataSourceを直接mutateしない。すべてCommandSinkへ編集意図を送る。
- previewはFrontendのephemeral overlayへ適用し、commitだけをRust canonical stateへ送る。
- ReactはToolbar、Track Tree、Context Menu、数値入力等を担当し、毎frameの操作状態を所有しない。

## 3. Temporal Document

### 3.1 Entity構造

```text
TemporalDocument
└─ Sequence
   ├─ Tracks
   ├─ Groups
   ├─ Bindings
   └─ Sequence Markers

Track
├─ Clips
├─ Cues
├─ Channels
└─ Track Markers

Clip
├─ Source?
├─ Channels
├─ Cues
└─ Clip Markers

Channel<T>
└─ Key<T>
```

実装は深いobject nestingではなく、typed IDをkeyとする正規化Mapにする。IDはRustがUUID v7を生成し、Frontendではopaque stringとして扱う。

### 3.2 公開概念

- `Clip`: half-open range `[start, end)`とlocal time mappingを持つTemporal Entity。
- `Cue`: pointに置かれるTemporal Entity。Range、Trim、Durationを要求しない。
- `EventCue`: 瞬間Event。再生区間のcrossing query対象。
- `EventClip`: Clip kindの一つ。`onEnter / onUpdate / onExit` payloadを持つ。
- `Marker`: pointまたはrangeの非評価Annotation。再生しても発火しない。
- `Channel<T>`: TrackまたはClipが所有できる型付き値系列。
- `Key<T>`: Channel内の時間sample。Eventを`Channel<Event>`として表現しない。
- `Group`: Folder、色、表示順などUI整理。
- `Binding`: Actor、Bone、Property、Audio Output等の評価対象。

`Section`は公開概念として採用しない。Trackは`groupId`と`bindingId`を独立参照する。

### 3.3 Marker scope

- Sequence Marker: rulerへ投影する。
- Track Marker: Track rowへ投影する。
- Clip Marker: 一つのClip instanceだけに属し、clip local timeで保存する。
- Source Marker: Source timeに属し、同じSourceを使うClipへTimeMappingして投影する。

### 3.4 TimeMapping

初期版はaffine変換のみを扱う。

- Source offset
- signed rational rate
- 負rateによるreverse
- Clip range外は`null`

Loop、Hold、Ping-pong、非線形Speed Rampは後続phaseへ送る。

### 3.5 Event評価

値Channelは`sample(time)`、Eventは`queryCrossedEvents(previous, current, context)`という別contractにする。

Event evaluatorは副作用を実行せず、発生すべきEvent recordを決定論的な順序で返す。standalone既定policyは次のとおり。

- forward playback: EventCueを`(previous, current]`で発火
- reverse playback: 発火しない
- seek／scrub: 発火しない
- loop: 時間区間をloop境界で分割してforward評価

AppはPlayback policyを差し替え可能にする。

## 4. Time Model

同一Document内でSecondsとTicksを混在させない。Timeline Engine instanceへ一つの`TimeDomain`を注入する。

```ts
type TimeValue = number;

interface TimeDomain {
  readonly kind: "seconds" | "ticks";
  normalize(value: number): TimeValue;
  fromSeconds(seconds: number): TimeValue;
  toSeconds(time: TimeValue): number;
  fromFrame(frame: number): TimeValue;
  toFrame(time: TimeValue): number;
  add(time: TimeValue, delta: number): TimeValue;
  compare(a: TimeValue, b: TimeValue): number;
}
```

- Rust／wireもJSON numberへ統一する。
- Secondsはfinite `f64`を許可する。
- Tick domainは整数かつJavaScript safe integer範囲を強制する。
- Frame rateは有理数`numerator / denominator`として保持する。
- 保存演算の`TimeDomain`、表示の`TimeFormatter`、編集gridの`SnapStrategy`、座標変換の`ViewTransform`を分離する。
- 表示formatやSnap gridの変更でcanonical値を変換しない。

Tick範囲が`Number.MAX_SAFE_INTEGER`を超える要件が出た場合は、`bigint`または文字列wire formatを再検討する。

## 5. Frontend Contracts

### 5.1 DataSource

```ts
interface TimelineDataSource {
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  getRows(query: RowRange): TimelineRow[];
  getItems(query: VisibleTimeQuery): TimelineItem[];
  getKeys(query: VisibleTimeQuery): TimelineKey[];
}
```

- queryは同期的で、同一revisionのsnapshotを返す。
- rowとtime rangeでvirtualizeできる。
- Stable IDを持ち、Canvas hit resultからApp entityへ戻せる。
- Marker、EventCue、Clip、Keyを別item kindとして返す。
- Bindingをtree nodeへ投影してもGroupと同じ保存entityにしない。

### 5.2 CommandとTransaction

Commandはclosureを持たないserializableなdiscriminated unionにする。

```ts
type TimelineCommand =
  | { type: "moveItems"; itemIds: string[]; delta: TimeValue }
  | { type: "trimClip"; clipId: string; edge: "start" | "end"; time: TimeValue }
  | { type: "deleteItems"; itemIds: string[] }
  | { type: "insertKeys"; keys: TimelineKey[] };

type TimelineEditEvent =
  | { phase: "begin"; transactionId: string; baseRevision: number }
  | { phase: "preview"; transactionId: string; command: TimelineCommand }
  | { phase: "commit"; transactionId: string; command: TimelineCommand }
  | { phase: "cancel"; transactionId: string };
```

- preview commandはdrag開始状態を基準とし、前previewへ累積適用しない。
- Escape、pointercancel、focus lossでcancelする。
- commitだけをRustへ送り、Rust Historyへ一件積む。
- Rustは`baseRevision`を検証する。不一致時はv1ではrebaseせずcancelし、最新snapshotへ戻す。
- Rustはcommit適用時にinverse commandを生成し、Undo／Redoへ使用する。

### 5.3 ActionとSelection

- Engineは`deleteSelection`、`nudgeSelection`、`duplicateSelection`、`selectAll`、`cancelInteraction`等のActionを公開する。
- App統合時のglobal keybindとfocus routingはAppが所有する。
- Tauri統合時のSelectionはcontrolled、standalone版はlocal storeを既定とする。
- Engineはselection intentを発行し、controlled modeで正本を勝手に変更しない。

## 6. Rendering and Performance

Canvas 2Dから開始する。

- row virtualization
- Channel内の時刻順配列＋二分探索
- visible time range query
- pixel単位の密集Key集約
- layer別dirty rendering
- devicePixelRatio対応
- paintとhit testで同一`ViewTransform`を共有

hot path:

```text
pointermove
  → engine.interaction.update()
  → invalidate canvas
  → requestAnimationFrame repaint
  → React renderなし
  → Rust IPCなし
```

### 6.1 通常gate

- 500 Track
- 100,000 Key
- 可視40〜60行
- pan／zoom／scrubのp95 frame: 16.7ms以内
- Canvas paint p95: 8ms以内、4msを改善目標
- pointermove 120回中のReact render増加: 0
- 非可視Entity描画: 0

### 6.2 Stress gate

- 2,000 Track
- 1,000,000 Key
- 可視40〜60行
- pan／zoom／scrubのp95 frame: 16.7ms以内を目標
- 非可視Entity描画: 0

100万Key gateが未達の場合だけ、Worker、OffscreenCanvas、WebGPU、追加spatial indexを比較する。

## 7. Module Structure

PoC中はpackage公開を先行させず、依存方向を守るlogical moduleとして実装する。

```text
src/timeline/
├─ core/          # time, datasource, selection, interaction, layout
├─ canvas/        # imperative Canvas renderer
├─ react/         # React adapter
├─ standalone/    # local store, history, keymap, vanilla mount
└─ adapters/
   └─ tauri/      # projection cache and command sink

src-tauri/src/temporal/
├─ model.rs
├─ validation.rs
├─ command.rs
├─ history.rs
├─ evaluation.rs
└─ projection.rs
```

standalone consumerで再利用性を実証してから、`temporal-core / temporal-canvas / temporal-react / temporal-standalone / temporal-adapters`へworkspace package抽出する。

Plugin APIはTauri縦切り後に内部APIとして導入する。Capability、renderer、hit tester、command、inspector、serializerを登録できるようにするが、runtime evaluatorはUI pluginから分離する。Graph／Clip／Eventの実例が揃うまで公開固定しない。

## 8. Implementation Phases

### Phase 0 — Contract、test基盤、10万Key spike

- `src/timeline/`へlogical module境界を作り、逆向き依存を禁止する。
- VitestでTimeDomain、ViewTransform、DataSource、Command、Transactionのunit／contract test基盤を追加する。
- PlaywrightでChromium上のinteraction、visual、performance harnessを追加する。
- Track／Clip／Channel／Key／Marker／EventCueを含む10万Key fixtureを作る。
- read-only Canvas spikeでrow／time virtualization、DPI、pan／zoom／scrubを測る。

完了条件:

- Seconds／Ticksを同じAPIで切り替えられる。
- 非可視Keyを描画しない。
- 10万Keyの通常gateを満たす。
- pointermove中にReact renderを発生させない。

### Phase 1 — Rust canonical TemporalDocument

- UUID v7 typed ID、正規化Store、TimeDomain metadata、Entity modelを実装する。
- reference validation、serde round-trip、Command、History、Event evaluatorを実装する。
- Marker／Event、Group／Binding、Clip／Cueを含むfixtureをRustとTypeScriptで共有する。

完了条件:

- valid fixtureが情報を失わずround-tripする。
- dangling reference、domain不一致、invalid range、非finite Seconds、unsafe Tickを具体的errorとして拒否する。
- MarkerがEvent評価へ混入しない。
- commit／Undo／RedoでDocumentとrevisionが決定論的に変化する。

### Phase 2 — Read-only Engine／CanvasとTauri Projection

- Rustからrevision付きsnapshotを生成し、Frontend projection cacheへロードする。
- DataSourceをprojection cacheへ接続する。
- Ruler、Grid、Playhead、Clip、Cue、Marker、KeyをCanvas描画する。
- React adapterで既存Timeline panelへCanvasとTrack Treeをmountする。
- Dock resizeとDPI変更でpaint／hit test用ViewTransformを同時更新する。

完了条件:

- Tauri起動時にRust fixtureがTimelineへ表示される。
- Seconds／Ticks、frame／seconds表示を切り替えてもcanonical値が変化しない。
- Dock resize後もglyph位置とhit targetが一致する。
- Timeline操作がRust IPCを毎frame発生させない。

### Phase 3 — 最小編集縦切り

- Selection、hit test、box selection、snap、cursor中心zoomを追加する。
- Clip、Key、Cue、MarkerのMove Transactionを実装する。
- CommandSinkをTauri commit commandへ接続する。
- Rust reject、revision conflict、IPC failure時にpreviewを破棄して最新snapshotへ戻す。
- App-level Undo／Redo ActionをRust Historyへ接続する。

完了条件:

- 100回のdrag previewがRust History一件になる。
- cancel時はRust canonical stateが不変。
- Undo一回でdrag前、Redo一回でdrag後へ戻る。
- Marker移動でEventが生成されない。
- pointermove中のReact renderとRust IPCが0。

### Phase 4 — Editor Projection拡張

次の順番で実装する。

1. Dope Sheet: Channel tree、Key集約、複数選択、移動、複製、削除、interpolation変更
2. Graph Editor: 同じChannel／Key IDを使うcurve、tangent、handle編集
3. Clip Timeline: trim、slip、stretch、split、overlap表示
4. Event Editor／Marker Lane: Event policy、payload、scope別Marker projection
5. Animation／Audio／Video／Simulation Cache／Subsequence plugin

各Editorは別Storeを作らず、同じDocument ID、Selection、Command、Historyを共有する。

### Phase 5 — Standalone、package抽出、100万Key gate

- local Document、History、default keymap、Vanilla DOM mountを追加する。
- Tauri／Reactへ依存せず同じEngine／Canvas rendererが動くことを確認する。
- 実証後にworkspace packageへ抽出する。
- Plugin APIとserialization versionを公開安定化する。
- 100万Key fixtureをstress testする。

## 9. Test Plan

### Rust unit

- typed ID、正規化Store、TimeDomain validation
- TimeMapping、reference validation、serde round-trip
- Command inverse、History、revision conflict
- Event crossing、Marker非評価

### TypeScript unit

- Seconds／Ticks変換、NTSC frame変換、safe integer境界
- TimeRangeのhalf-open境界、ViewTransform往復
- snap優先順位、binary search、dense-key aggregation
- interaction state machine、preview非累積性

### Contract

- Rust fixtureとTypeScript DTO
- snapshot revision一貫性
- Command serialization
- controlled Selection
- Rust reject時のrollback

### Interaction／Visual

- cursor中心zoom、Canvas外drag、box select、multi-select
- begin／preview／commit／cancel、Undo／Redo
- focus routing、Dock resize、High DPI
- Clip重なり、Key密集、Marker scope、selected／hovered／mute／lock

### Performance

- Phase 0: 10万Keyの必須gate
- Phase 5: 100万Keyのstress gate
- query、layout、hit test、paint、React renderを個別計測

標準gateは`npm run build`、Vitest、Playwright、`cargo check --locked`、`cargo test --locked`を一括実行可能にする。

## 10. Risks and Review Triggers

### RustとJavaScriptの時間範囲

Tick値がsafe integerを超える場合、現wire contractを止めて`bigint`または文字列表現を再設計する。

### Previewとcanonical stateの乖離

Transaction IDとbase revisionを必須にし、commit reject時はcanonical snapshotへ戻す。v1では自動rebaseしない。

### CanvasとDOMの座標ずれ

一つのViewTransformをpaint、hit test、DOM overlayで共有し、DPI／Dock resizeをintegration test対象にする。

### Scope creep

Clip decoder、waveform、Graph interpolation、Subsequence等は、Phase 3のTauri縦切りが完了するまで追加しない。

### Architecture review trigger

次のいずれかを検知した場合、該当phaseを止めてownership／projection／rendering方式を再評価する。

- Timeline操作が毎frame Rust IPCを必要とする。
- Frontendにcanonical Documentの複製が必要になる。
- Seconds／TicksのDocument単位選択で要件を満たせない。
- Source MarkerをSource timeから安定して投影できない。
- 10万KeyでCanvas 2Dのframe budgetを満たせない。
- projection cacheがmemory budgetを超える。

## 11. Fixed Defaults

- 現在のTauri／Reactアプリを最初のconsumerとする。
- Rust App CoreがDocumentとHistoryの正本になる。
- 初期実装は現package内のlogical moduleで行う。
- Entity IDはRust生成UUID v7、Frontendではopaque stringとする。
- TimeValueはJSON numberへ統一し、Tick domainではsafe integerを強制する。
- Projection同期はrevision付きsnapshotから開始する。
- revision conflictはcancel＋最新snapshot復元とする。
- Canvas 2Dを既定とする。
- Plugin APIは内部利用から始める。
