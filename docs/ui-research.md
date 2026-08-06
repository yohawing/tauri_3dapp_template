# UI層調査メモ(2026-08-06)

DCCエディタシェル(Toolbar / Outliner / Viewport / Inspector / Timeline)を構築するためのUIライブラリ調査と、three.js系OSSエディタからの借用可能性調査のまとめ。

前提: 中央ViewportHostは透明なDOMの穴(背面にnative wgpu)。レイアウトライブラリは透明パネルを許容し、正確なDOM矩形が取得できること。

## 推奨スタック

| 役割 | 本命 | 次点 | 備考 |
|---|---|---|---|
| Dockレイアウト | **dockview** (MIT, 活発, React 19対応) | flexlayout-react (MIT) | golden-layoutは半メンテ停止+ドラッグ実装が透明穴と相性最悪。rc-dockは停滞 |
| Inspector | **tweakpane** (MIT) or **@playcanvas/pcui** (MIT) | leva (MIT, pmndrs) | PCUIは公式Reactバインディングあり、TreeView等も同梱 |
| Outlinerツリー | **react-arborist** (MIT, 仮想化+D&D+リネーム) | react-complex-tree / PCUI TreeView | 数千ノード規模なら仮想化のあるarborist |
| Timeline | **自前実装**(@xzdarcy/react-timeline-editor (MIT) を下地に) | — | Theatre.js の studio UI は AGPL のため組込不可。既製の決定版は存在しない |
| 汎用部品 | Blueprint (Apache-2.0, ツール系UI資産が豊富) or shadcn/ui + Radix (MIT) | — | |

### 注意点(全ライブラリ共通)

- **ドック/パネルのドラッグ中のポインタイベント**: 透明穴の上でドラッグイベントが失われる可能性があるため、ドラッグ中のみ透明オーバーレイdivを被せて pointer-events を奪う対策が定石。どれを選んでも自前実装が必要。
- **Timelineのホットパス**: 実例として Reze Studio(後述)は、キーフレームドラッグ/再生などの60fps更新をReactを迂回してref直接ミューテート+`useSyncExternalStore` で実装している。既製Reactライブラリに頼らないのがこの分野の現実解。

## three.js系エディタからの借用候補(ライセンス確認済み)

### 借りられるもの

1. **@playcanvas/pcui** (MIT) — PlayCanvasは2025年8月に**Editor FrontendまでMITでOSS化**。PCUIは製作ツール向けUIコンポーネント集(TreeView / Panel / フォーム類)で公式Reactバインディングあり。Outliner/Inspectorをゼロから作らない最有力候補。
2. **pmndrs/drei のギズモ・カメラ群** (MIT) — `TransformControls` / `PivotControls` / `GizmoViewport` / `CameraControls`(内部は yomotsu/camera-controls, MIT)。Canvasバックエンドではそのまま使用、Native wgpu側はドラッグ操作ステートマシンの移植仕様書として活用。
3. **Pascal Editor** (pascalorg/editor, MIT, 非常に活発) — シーングラフを**フラット辞書 `Record<id, Node>` + parentId/children参照**で持つデータモデルと、**Zustand + Zundo** による軽量Undo/Redo。UI Projection側の状態設計にそのまま応用可能。
4. **three.js 公式editor** (MIT) — `editor/js/commands/*` + `History.js` のCommand pattern Undo/Redo。本プロジェクトは正本stateがRust側(PLAN §9)なので、**Undo/RedoをRust側でCommand patternとして実装する際の設計参考**として最重要。
5. **Babylon.js Editor** (Apache-2.0) — Electron + React + Tailwind の公式デスクトップエディタ。「ネイティブシェル + React UI + 3Dエンジン」というアーキテクチャが最も近い前例。コンポーネント設計・選択状態・プロパティバインディングの実例。

### 借りてはいけないもの

- **Theatre.js `@theatre/studio`** / **Triplex の editor系パッケージ** — AGPL-3.0。クローズドソース配布物への組込はソース開示義務リスク。`@theatre/core`(Apache-2.0)のキーフレームデータモデルは参考可。
- **Rogue Engine** — 非OSS、流用は規約違反。
- **pmndrs/react-three-editor** — archived (2023)。
- **Needle Engine** — コア非公開かつ編集はUnity/Blender側で行う設計のため無関係。

### 個別評価: baku89/tweeq

橋本麦氏のVue 3製パラメータ調整UIキット(MIT、UIST 2025論文の実装)。`InputRotary` / `InputCubicBezier` / `Timeline` / `PaneZUI` などアニメツール向けウィジェットが揃いコンセプトは本プロジェクトのど真ん中だが、**採用は見送り**:

- Vue 3専用・npm未配布(`private: true`、git依存のみ)・`TweeqProvider`+Pinia前提の深い統合設計で、React 19からの利用は第2フレームワーク常設が必要
- 実質ソロ開発(バス係数1)、サードパーティ採用ゼロ、内部API変動中
- 回転ノブ/ベジェエディタは tweakpane プラグイン(`@tweakpane/plugin-cubic-bezier`、`tweakpane-plugin-rotation`)で代替可能

**借用価値**: 数値スクラブの操作感(フォーカス状態別ドラッグ挙動、px-per-step感度、修飾キー精度切替)の実装知見と、ウィジェット一覧のチェックリスト的価値。独自Timeline/カスタムウィジェット実装時に参照する。
https://github.com/baku89/tweeq / https://baku89.github.io/tweeq/ / https://dl.acm.org/doi/10.1145/3746059.3747723

### 同領域の実例

- **Reze Studio** (AmyangXYZ/reze-studio) — MMDモーション編集 + WebGPU + ドープシート/ベジェカーブエディタを実装した実在プロジェクト。Next.js 16 + React 19 + shadcn/ui。本プロジェクトのユースケース(MMD/モーション編集)と直接重なるため要ウォッチ。

## 結論

- Outliner/Inspector/Dockは既製MITライブラリで賄える(dockview + react-arborist + tweakpane/PCUI)。
- Timelineだけは自前実装が避けられない。設計はTheatre.js(見て学ぶだけ)とReze Studio、下地は@xzdarcy/react-timeline-editor。
- 「ネイティブビューポート + 透明DOM」構成の直接の前例はどこにもない。借用できるのはUI部品とデータモデル/状態管理パターンのみで、DOM⇔ネイティブ合成(入力ヒットテスト、矩形同期)は引き続き独自設計。

## 主要URL

- https://github.com/mathuo/dockview / https://github.com/caplin/FlexLayout
- https://github.com/brimdata/react-arborist / https://github.com/lukasbach/react-complex-tree
- https://github.com/cocopon/tweakpane / https://github.com/pmndrs/leva
- https://github.com/xzdarcy/react-timeline-editor / https://github.com/theatre-js/theatre
- https://github.com/playcanvas/pcui / https://github.com/playcanvas/editor
- https://github.com/pmndrs/drei / https://github.com/yomotsu/camera-controls
- https://github.com/pascalorg/editor / https://github.com/charkour/zundo
- https://github.com/mrdoob/three.js/tree/dev/editor
- https://github.com/BabylonJS/Editor
- https://github.com/AmyangXYZ/reze-studio
