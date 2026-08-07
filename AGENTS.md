# AGENTS.md

このファイルは、このリポジトリで作業するcoding agent向けのプロジェクト固有指示です。

## 作業開始時

1. `TODO.md`を読み、現在の最優先項目、依存関係、非目標を確認する。
2. `docs/IDEA.md`でPoCの成功条件と採否ゲートを確認する。
3. `git status --short --branch`と対象ファイルの既存diffを確認し、無関係な変更を保持する。
4. 実装済み、設計のみ、未検証、実機証拠待ちを区別する。

Temporal Editorを扱う場合は`docs/TIMELINE_PLAN.md`も確認する。

明示的な指示がない限り、`TODO.md`のクリティカルパスを優先する。透明合成の成立性が確認できる前にPMX／VMD、Retarget、Physicsなどへscopeを広げない。


## 標準コマンド

PowerShell、リポジトリroot前提。

```powershell
npm ci
npm run tauri dev
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

利用可能なら外部commandへ`rtk`を付ける。Read／Grep／Glob／Editにはagentの内蔵toolを優先する。

## 変更後の検証

最低限:

```powershell
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Viewport、CSS、input、renderer lifecycleを変更した場合は、CLI gateだけで完了にしない。Tauri appを起動し、対象に応じて以下を目視・記録する。

- Native cubeが透明Viewport内だけに表示される。
- DOM panelとPopupがViewport上へ正しく重なる。
- Dock resize／move後にViewport位置とScissorが一致する。
- Orbit／Pan／Zoomとpointer captureが動く。
- Native→Canvas→NativeでCameraが飛ばない。
- inactive backendが描画を続けない。

必要に応じて`TAURI3D_LOG_VIEWPORT_RECT`、`VITE_INPUT_SELF_TEST`、`VITE_BACKEND_SELF_TEST`、`VITE_DOCK_SELF_TEST`を使う。pass／fail／未検証と実行環境を明記する。

GUI確認ではComputer Useをなるべく使わない。まずCLI gate、`VITE_*_SELF_TEST`、ログ、`screenshot-ui`による起動・ウィンドウキャプチャなど、再現可能で非対話的な経路を優先する。Computer Useは、それらでは確認できない操作が完了条件に含まれ、ほかに安全な手段がない場合だけ最小範囲で使い、使用理由と確認内容を報告する。


## Git境界

- Alpha版のPoCなので、こまかくcommitしながら進めてOK
