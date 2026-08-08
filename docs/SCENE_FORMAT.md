# Scene file format

Status: Scene v1 schema／pure Rust validation／Kiss3D起動接続を実装し、Windows実機でbuilt-in・sample・invalid Sceneを検証済み。

## 目的

`.scene.json`へローカルAsset、instance Transform、Camera初期値を保存し、同じPoC起動条件を再現する。Scene Editorや汎用runtime architectureを定義するものではない。

## 非目標

- 完成版DCC／game engine scene format
- UI authoring、Save／Save As、autosave
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

永続型にはTauri、Kiss3D、wgpu、Three.jsの型やruntime handleを入れない。Kiss3D runtime Sceneは読み込んだ`Scene`から起動時に構築する。

## Path規則

- 相対pathは`.scene.json`の親directoryを基準に解決する。
- 絶対pathはローカルPoC用途として許可する。
- 保存値を起動時のcurrent working directory基準にしない。
- path解決後のfile不存在は、Scene schema errorと区別して報告する。
- 正規化した絶対pathをScene JSONへ勝手に書き戻さない。

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

## 起動選択

初版は環境変数を使用する。

```powershell
$env:TAURI3D_SCENE = "experiments/gltf-lighting.scene.json"
npm run tauri dev
```

未指定時は既存Cube相当のbuilt-in Sceneを使う。File Picker、Recent Files、last-opened Sceneの永続化は今回作らない。

## 保存の範囲

v1ではSerdeのdeserialize／serialize round-tripを保証する。UIからのファイル書き込みは実装しない。将来Saveが必要になった時点で、atomic write、dirty state、error recoveryを別スライスとして設計する。

## Canvas境界

Canvasは`.scene.json`のconsumerにしない。現在の固定fallback SceneとCamera continuityを維持する。Scene AssetやMaterialの同期が本当に必要になった場合だけ、別の小さなDTOを検討する。
