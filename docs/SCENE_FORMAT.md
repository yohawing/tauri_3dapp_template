# Scene file format

Status: Scene v1 schema／pure Rust validation／Kiss3D runtime差し替え／FileメニューのNew・Open・Save・Save Asを実装し、Windows実機で検証済み。

## 目的

`.scene.json`へローカルAsset、instance Transform、Camera初期値を保存し、同じPoC起動条件を再現する。Scene Editorや汎用runtime architectureを定義するものではない。

## 非目標

- 完成版DCC／game engine scene format
- Scene graph authoring、autosave、dirty-state確認dialog
- Undo／Redo、Transaction、collaboration
- component system、reflection、plugin schema
- Asset database、import pipeline、cache
- Native／Canvas共通render graph
- version migration framework

## ファイル名

拡張子は`.scene.json`とする。

例:

```text
experiments/
├─ gltf-lighting.scene.json
└─ assets/
   └─ character.glb
```

## Scene v1案

```json
{
  "version": 1,
  "name": "gltf-lighting",
  "assets": [
    {
      "id": "character",
      "kind": "gltf",
      "path": "./assets/character.glb"
    }
  ],
  "instances": [
    {
      "id": "character-1",
      "asset": "character",
      "translation": [0.0, 0.0, 0.0],
      "rotation": [0.0, 0.0, 0.0, 1.0],
      "scale": [1.0, 1.0, 1.0],
      "visible": true
    }
  ],
  "camera": {
    "target": [0.0, 1.0, 0.0],
    "yaw": -0.6,
    "pitch": 0.35,
    "distance": 4.0
  }
}
```

`assets[].kind` は `gltf`（glTF/GLB）または `fbx`。FBXは三角形メッシュ、ノード階層、
4-weight linear skin、UV0、法線、base color／metallic／roughnessのスカラー値を読み込む。
FBX transform animationはsource FPS（上限60 fps）でlinear keyへbakeし、最初のclipを自動loop再生する。
モーフアニメーション、テクスチャ、NURBS、FBX固有の補間曲線は未対応。

## Rust永続型の方向

永続型の名前は用途どおり単に`Scene`とする。

```rust
struct Scene {
    version: u32,
    name: Option<String>,
    assets: Vec<SceneAsset>,
    instances: Vec<SceneInstance>,
    camera: Option<SceneCamera>,
}
```

永続型にはTauri、Kiss3D、wgpu、Three.jsの型やruntime handleを入れない。Kiss3D runtime Sceneは読み込んだ`Scene`から起動時またはFile > Open時に構築する。

## Path規則

- 相対pathは`.scene.json`の親directoryを基準に解決する。
- 絶対pathはローカルPoC用途として許可する。
- 保存値を起動時のcurrent working directory基準にしない。
- path解決後のfile不存在は、Scene schema errorと区別して報告する。
- Save Asでは元のresolved assetを維持するよう保存先からの相対pathへrebaseする。Windowsでdriveが異なり相対化できない場合だけ絶対pathへfallbackする。

## Validation

v1では最低限、次をfail closedで検証する。

- `version == 1`
- Asset IDとinstance IDが空でなく重複しない
- instanceが存在するAsset IDを参照する
- TransformとCameraの数値がfinite
- scale各軸が0より大きい
- Camera distanceが0より大きい
- Asset kindが実装済みの値である

未知fieldと未知versionは受理せず、v1 schemaをfail closedで検証する。

## Open／起動選択

通常操作はFile > Openを使用する。開発時に起動直後から固定Sceneを読みたい場合は環境変数も使用できる。

```powershell
$env:TAURI3D_SCENE = "experiments/gltf-lighting.scene.json"
npm run tauri dev
```

未指定時は既存Cube相当のbuilt-in Sceneを使う。File Pickerは実装済み。Recent Filesとlast-opened Sceneの永続化は今回作らない。

## 保存の範囲

v1ではSerdeのdeserialize／serialize round-tripに加え、File > Save／Save AsでCameraの現在値とScene documentを書き込む。Newはassetを持たない`Untitled` Sceneを作る。built-in CubeはScene v1の永続型ではないため、built-in状態ではSave／Save Asを無効化し、先にNewまたはOpenを要求する。atomic replace、dirty state、終了時確認は後続スライスとする。

## Canvas境界

Canvasは`.scene.json`のconsumerにしない。現在の固定fallback SceneとCamera continuityを維持する。Scene AssetやMaterialの同期が本当に必要になった場合だけ、別の小さなDTOを検討する。
