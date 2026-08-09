//! Persistent Scene JSON v1 types and validation.
//!
//! This module deliberately contains only the file-format boundary.  It does
//! not know about Tauri, Kiss3d, wgpu, or any renderer handles.  Runtime scene
//! construction belongs to a later integration slice.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SCENE_VERSION: u32 = 1;

/// The persistent Scene v1 document.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    pub version: u32,
    #[serde(default)]
    pub name: Option<String>,
    pub assets: Vec<SceneAsset>,
    pub instances: Vec<SceneInstance>,
    #[serde(default)]
    pub camera: Option<SceneCamera>,
}

/// A local asset referenced by one or more [`SceneInstance`] values.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SceneAsset {
    pub id: String,
    pub kind: String,
    pub path: String,
}

/// An instance of a Scene asset.
///
/// The transform is flattened in JSON to match `docs/SCENE_FORMAT.md` while
/// remaining a distinct Rust value at the API boundary.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneInstance {
    pub id: String,
    pub asset: String,
    pub transform: SceneTransform,
    pub visible: bool,
}

// `serde(flatten)` cannot be combined reliably with `deny_unknown_fields`.
// Keep the public API nested, but deserialize the wire shape through a strict
// helper so unknown instance fields still fail closed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SceneInstanceWire {
    id: String,
    asset: String,
    translation: [f64; 3],
    rotation: [f64; 4],
    scale: [f64; 3],
    visible: bool,
}

impl Serialize for SceneInstance {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        SceneInstanceWire {
            id: self.id.clone(),
            asset: self.asset.clone(),
            translation: self.transform.translation,
            rotation: self.transform.rotation,
            scale: self.transform.scale,
            visible: self.visible,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SceneInstance {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = SceneInstanceWire::deserialize(deserializer)?;
        Ok(Self {
            id: wire.id,
            asset: wire.asset,
            transform: SceneTransform {
                translation: wire.translation,
                rotation: wire.rotation,
                scale: wire.scale,
            },
            visible: wire.visible,
        })
    }
}

/// Translation, quaternion rotation, and positive scale for an instance.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SceneTransform {
    pub translation: [f64; 3],
    pub rotation: [f64; 4],
    pub scale: [f64; 3],
}

/// Initial orbit-camera state persisted by a Scene.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SceneCamera {
    pub target: [f64; 3],
    pub yaw: f64,
    pub pitch: f64,
    pub distance: f64,
}

/// Whether an asset path can be moved with a Scene file or is machine-local.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetPathKind {
    /// The stored path was relative and was resolved from the Scene file's
    /// parent directory.
    PortableRelative,
    /// The stored path was absolute and therefore machine-local.
    AbsoluteLocal,
}

/// A validated asset path resolved against a Scene file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedAssetPath {
    pub asset_id: String,
    pub stored_path: PathBuf,
    pub resolved_path: PathBuf,
    pub kind: AssetPathKind,
}

impl ResolvedAssetPath {
    pub fn is_portable(&self) -> bool {
        self.kind == AssetPathKind::PortableRelative
    }

    pub fn is_absolute_local(&self) -> bool {
        self.kind == AssetPathKind::AbsoluteLocal
    }
}

/// JSON parsing errors are kept separate from semantic validation errors.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SceneJsonErrorKind {
    Syntax,
    Schema,
}

/// Semantic validation failures for an already-deserialized Scene.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SceneValidationError {
    UnsupportedVersion {
        version: u32,
    },
    EmptyAssetId {
        index: usize,
    },
    DuplicateAssetId {
        id: String,
    },
    EmptyAssetPath {
        asset_id: String,
    },
    UnsupportedAssetKind {
        asset_id: String,
        kind: String,
    },
    EmptyInstanceId {
        index: usize,
    },
    DuplicateInstanceId {
        id: String,
    },
    MissingAssetReference {
        instance_id: String,
        asset_id: String,
    },
    NonFinite {
        field: String,
    },
    InvalidScale {
        instance_id: String,
        axis: usize,
    },
    InvalidCameraDistance,
}

/// Errors from parsing or loading a Scene.
///
/// The four top-level categories intentionally remain distinct: filesystem
/// access, JSON syntax/schema, semantic validation, and a missing resolved
/// asset file.
#[derive(Debug)]
pub enum SceneError {
    FileIo {
        path: PathBuf,
        kind: io::ErrorKind,
        message: String,
    },
    Json {
        kind: SceneJsonErrorKind,
        message: String,
    },
    Validation(SceneValidationError),
    MissingAsset {
        asset_id: String,
        stored_path: PathBuf,
        resolved_path: PathBuf,
        path_kind: AssetPathKind,
    },
}

impl fmt::Display for SceneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FileIo { path, message, .. } => {
                write!(
                    formatter,
                    "scene file I/O failed for {}: {message}",
                    path.display()
                )
            }
            Self::Json { kind, message } => write!(formatter, "scene JSON {kind:?}: {message}"),
            Self::Validation(error) => write!(formatter, "scene validation failed: {error:?}"),
            Self::MissingAsset {
                asset_id,
                resolved_path,
                path_kind,
                ..
            } => write!(
                formatter,
                "scene asset '{asset_id}' ({path_kind:?}) does not exist at {}",
                resolved_path.display()
            ),
        }
    }
}

impl std::error::Error for SceneError {}

impl Scene {
    /// Construct an empty, valid Scene document suitable for File > New.
    pub fn empty(name: impl Into<String>) -> Self {
        Self {
            version: SCENE_VERSION,
            name: Some(name.into()),
            assets: Vec::new(),
            instances: Vec::new(),
            camera: None,
        }
    }

    /// Parse and semantically validate a JSON Scene document.
    pub fn parse_json(input: &str) -> Result<Self, SceneError> {
        let scene = serde_json::from_str::<Self>(input).map_err(|error| SceneError::Json {
            kind: if error.is_syntax() || error.is_eof() {
                SceneJsonErrorKind::Syntax
            } else {
                SceneJsonErrorKind::Schema
            },
            message: error.to_string(),
        })?;
        scene.validate().map_err(SceneError::Validation)?;
        Ok(scene)
    }

    /// Read, parse, validate, resolve, and existence-check a Scene file.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, SceneError> {
        let path = path.as_ref();
        let input = fs::read_to_string(path).map_err(|error| SceneError::FileIo {
            path: path.to_path_buf(),
            kind: error.kind(),
            message: error.to_string(),
        })?;
        let scene = Self::parse_json(&input)?;
        scene.check_resolved_assets(path)?;
        Ok(scene)
    }

    /// Validate and write a stable, human-readable Scene JSON document.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), SceneError> {
        self.validate().map_err(SceneError::Validation)?;
        let path = path.as_ref();
        let mut encoded = serde_json::to_string_pretty(self).map_err(|error| SceneError::Json {
            kind: SceneJsonErrorKind::Schema,
            message: format!("scene serialization failed: {error}"),
        })?;
        encoded.push('\n');
        fs::write(path, encoded).map_err(|error| SceneError::FileIo {
            path: path.to_path_buf(),
            kind: error.kind(),
            message: error.to_string(),
        })
    }

    /// Clone this document for a new Scene-file location while preserving the
    /// resolved asset targets. An untitled document has no source base, so its
    /// imported absolute paths are made relative to the first save location.
    pub fn rebased_for_save(
        &self,
        source_scene_file: Option<&Path>,
        target_scene_file: &Path,
    ) -> Result<Self, SceneError> {
        let target_file = absolute_path(target_scene_file)?;
        let target_parent = target_file.parent().unwrap_or_else(|| Path::new("."));
        let canonical_target_parent = target_parent
            .canonicalize()
            .unwrap_or_else(|_| target_parent.to_path_buf());
        let mut rebased = self.clone();
        if let Some(source_scene_file) = source_scene_file {
            let resolved = self.resolve_asset_paths(source_scene_file)?;
            for (asset, resolved) in rebased.assets.iter_mut().zip(resolved) {
                let canonical_asset = resolved
                    .resolved_path
                    .canonicalize()
                    .unwrap_or(resolved.resolved_path);
                asset.path = pathdiff::diff_paths(&canonical_asset, &canonical_target_parent)
                    .unwrap_or(canonical_asset)
                    .to_string_lossy()
                    .into_owned();
            }
        } else {
            for asset in &mut rebased.assets {
                let imported_path = PathBuf::from(&asset.path);
                if imported_path.is_absolute() {
                    asset.path = pathdiff::diff_paths(&imported_path, &canonical_target_parent)
                        .unwrap_or(imported_path)
                        .to_string_lossy()
                        .into_owned();
                }
            }
        }
        rebased.validate().map_err(SceneError::Validation)?;
        Ok(rebased)
    }

    /// Validate the version, IDs, references, numeric values, and asset kind.
    pub fn validate(&self) -> Result<(), SceneValidationError> {
        if self.version != SCENE_VERSION {
            return Err(SceneValidationError::UnsupportedVersion {
                version: self.version,
            });
        }

        let mut asset_ids = std::collections::HashSet::with_capacity(self.assets.len());
        for (index, asset) in self.assets.iter().enumerate() {
            if asset.id.trim().is_empty() {
                return Err(SceneValidationError::EmptyAssetId { index });
            }
            if !asset_ids.insert(asset.id.clone()) {
                return Err(SceneValidationError::DuplicateAssetId {
                    id: asset.id.clone(),
                });
            }
            if asset.path.trim().is_empty() {
                return Err(SceneValidationError::EmptyAssetPath {
                    asset_id: asset.id.clone(),
                });
            }
            if !matches!(asset.kind.as_str(), "gltf" | "fbx") {
                return Err(SceneValidationError::UnsupportedAssetKind {
                    asset_id: asset.id.clone(),
                    kind: asset.kind.clone(),
                });
            }
        }

        let mut instance_ids = std::collections::HashSet::with_capacity(self.instances.len());
        for (index, instance) in self.instances.iter().enumerate() {
            if instance.id.trim().is_empty() {
                return Err(SceneValidationError::EmptyInstanceId { index });
            }
            if !instance_ids.insert(instance.id.clone()) {
                return Err(SceneValidationError::DuplicateInstanceId {
                    id: instance.id.clone(),
                });
            }
            if !asset_ids.contains(&instance.asset) {
                return Err(SceneValidationError::MissingAssetReference {
                    instance_id: instance.id.clone(),
                    asset_id: instance.asset.clone(),
                });
            }

            validate_finite(
                &instance.transform.translation,
                format!("instances[{index}].translation"),
            )?;
            validate_finite(
                &instance.transform.rotation,
                format!("instances[{index}].rotation"),
            )?;
            validate_finite(
                &instance.transform.scale,
                format!("instances[{index}].scale"),
            )?;
            for (axis, value) in instance.transform.scale.iter().copied().enumerate() {
                if value <= 0.0 {
                    return Err(SceneValidationError::InvalidScale {
                        instance_id: instance.id.clone(),
                        axis,
                    });
                }
            }
        }

        if let Some(camera) = &self.camera {
            validate_finite(&camera.target, "camera.target".to_string())?;
            validate_finite(&[camera.yaw], "camera.yaw".to_string())?;
            validate_finite(&[camera.pitch], "camera.pitch".to_string())?;
            validate_finite(&[camera.distance], "camera.distance".to_string())?;
            if camera.distance <= 0.0 {
                return Err(SceneValidationError::InvalidCameraDistance);
            }
        }

        Ok(())
    }

    /// Resolve every stored asset path against the Scene file's parent.
    ///
    /// This method does not touch the filesystem; use
    /// [`Scene::check_resolved_assets`] or [`Scene::load`] when existence
    /// checking is desired.
    pub fn resolve_asset_paths(
        &self,
        scene_file: impl AsRef<Path>,
    ) -> Result<Vec<ResolvedAssetPath>, SceneError> {
        self.validate().map_err(SceneError::Validation)?;
        let scene_file = scene_file.as_ref();
        let scene_file = if scene_file.is_absolute() {
            scene_file.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|error| SceneError::FileIo {
                    path: scene_file.to_path_buf(),
                    kind: error.kind(),
                    message: error.to_string(),
                })?
                .join(scene_file)
        };
        let scene_parent = scene_file.parent().unwrap_or_else(|| Path::new("."));

        Ok(self
            .assets
            .iter()
            .map(|asset| {
                let stored_path = PathBuf::from(&asset.path);
                let kind = if stored_path.is_absolute() {
                    AssetPathKind::AbsoluteLocal
                } else {
                    AssetPathKind::PortableRelative
                };
                let resolved_path = if kind == AssetPathKind::AbsoluteLocal {
                    stored_path.clone()
                } else {
                    scene_parent.join(&stored_path)
                };
                ResolvedAssetPath {
                    asset_id: asset.id.clone(),
                    stored_path,
                    resolved_path,
                    kind,
                }
            })
            .collect())
    }

    /// Resolve all paths and report the first asset file that is not present.
    pub fn check_resolved_assets(
        &self,
        scene_file: impl AsRef<Path>,
    ) -> Result<Vec<ResolvedAssetPath>, SceneError> {
        let resolved = self.resolve_asset_paths(scene_file)?;
        for asset in &resolved {
            if !asset.resolved_path.is_file() {
                return Err(SceneError::MissingAsset {
                    asset_id: asset.asset_id.clone(),
                    stored_path: asset.stored_path.clone(),
                    resolved_path: asset.resolved_path.clone(),
                    path_kind: asset.kind,
                });
            }
        }
        Ok(resolved)
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, SceneError> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    std::env::current_dir()
        .map(|current| current.join(path))
        .map_err(|error| SceneError::FileIo {
            path: path.to_path_buf(),
            kind: error.kind(),
            message: error.to_string(),
        })
}

fn validate_finite<const N: usize>(
    values: &[f64; N],
    field: String,
) -> Result<(), SceneValidationError> {
    if values.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err(SceneValidationError::NonFinite { field })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const VALID_JSON: &str = r#"
    {
      "version": 1,
      "name": "gltf-lighting",
      "assets": [{"id":"character","kind":"gltf","path":"./assets/character.glb"}],
      "instances": [{
        "id":"character-1", "asset":"character",
        "translation":[0.0,0.0,0.0], "rotation":[0.0,0.0,0.0,1.0],
        "scale":[1.0,1.0,1.0], "visible":true
      }],
      "camera": {"target":[0.0,1.0,0.0],"yaw":-0.6,"pitch":0.35,"distance":4.0}
    }
    "#;

    fn valid_scene() -> Scene {
        Scene::parse_json(VALID_JSON).expect("valid fixture")
    }

    #[test]
    fn accepts_static_fbx_asset_kind() {
        let mut scene = valid_scene();
        scene.assets[0].kind = "fbx".to_string();
        scene.assets[0].path = "./assets/prop.fbx".to_string();
        scene.validate().unwrap();
    }

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("tauri3d-scene-{label}-{nonce}"))
    }

    #[test]
    fn parses_and_round_trips_semantically() {
        let scene = valid_scene();
        let encoded = serde_json::to_string(&scene).expect("serialize");
        let decoded = Scene::parse_json(&encoded).expect("round trip");
        assert_eq!(scene, decoded);
    }

    #[test]
    fn rejects_unknown_version_and_fields() {
        let unknown_version = VALID_JSON.replace("\"version\": 1", "\"version\": 2");
        assert!(matches!(
            Scene::parse_json(&unknown_version),
            Err(SceneError::Validation(
                SceneValidationError::UnsupportedVersion { version: 2 }
            ))
        ));

        let unknown_field = VALID_JSON.replace(
            "\"name\": \"gltf-lighting\",",
            "\"name\": \"gltf-lighting\",\"extra\":true,",
        );
        assert!(matches!(
            Scene::parse_json(&unknown_field),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                ..
            })
        ));

        let unknown_instance_field =
            VALID_JSON.replace("\"visible\":true", "\"visible\":true,\"extra\":true");
        assert!(matches!(
            Scene::parse_json(&unknown_instance_field),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                ..
            })
        ));
    }

    #[test]
    fn rejects_duplicate_ids_and_missing_reference() {
        let duplicate_asset = VALID_JSON.replace(
            "{\"id\":\"character\",\"kind\":\"gltf\",\"path\":\"./assets/character.glb\"}",
            "{\"id\":\"character\",\"kind\":\"gltf\",\"path\":\"./assets/character.glb\"},{\"id\":\"character\",\"kind\":\"gltf\",\"path\":\"./assets/other.glb\"}",
        );
        assert!(matches!(
            Scene::parse_json(&duplicate_asset),
            Err(SceneError::Validation(
                SceneValidationError::DuplicateAssetId { .. }
            ))
        ));

        let duplicate_instance = VALID_JSON.replace(
            "}],\n      \"camera\"",
            "},{\"id\":\"character-1\",\"asset\":\"character\",\"translation\":[0,0,0],\"rotation\":[0,0,0,1],\"scale\":[1,1,1],\"visible\":true}],\n      \"camera\"",
        );
        assert!(matches!(
            Scene::parse_json(&duplicate_instance),
            Err(SceneError::Validation(
                SceneValidationError::DuplicateInstanceId { .. }
            ))
        ));

        let missing_reference =
            VALID_JSON.replace("\"asset\":\"character\"", "\"asset\":\"missing\"");
        assert!(matches!(
            Scene::parse_json(&missing_reference),
            Err(SceneError::Validation(
                SceneValidationError::MissingAssetReference { .. }
            ))
        ));
    }

    #[test]
    fn rejects_non_finite_scale_and_distance() {
        let mut scene = valid_scene();
        scene.instances[0].transform.translation[0] = f64::NAN;
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::NonFinite { .. })
        ));

        let mut scene = valid_scene();
        scene.instances[0].transform.scale[1] = 0.0;
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::InvalidScale { axis: 1, .. })
        ));

        let mut scene = valid_scene();
        scene.camera.as_mut().expect("camera").distance = -1.0;
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::InvalidCameraDistance)
        ));
    }

    #[test]
    fn resolves_relative_paths_from_scene_parent() {
        let scene = valid_scene();
        let root = temp_path("relative");
        let scene_file = root.join("experiments").join("example.scene.json");
        let resolved = scene.resolve_asset_paths(&scene_file).expect("resolve");
        assert_eq!(resolved[0].kind, AssetPathKind::PortableRelative);
        assert_eq!(
            resolved[0].stored_path,
            PathBuf::from("./assets/character.glb")
        );
        assert_eq!(
            resolved[0].resolved_path,
            root.join("experiments").join("assets/character.glb")
        );
    }

    #[test]
    fn resolves_relative_scene_file_from_current_dir_once() {
        let scene = valid_scene();
        let current_dir = std::env::current_dir().expect("current dir");
        let scene_file = PathBuf::from("relative-scene-tests/example.scene.json");
        let resolved = scene.resolve_asset_paths(&scene_file).expect("resolve");
        assert!(resolved[0].resolved_path.is_absolute());
        assert_eq!(
            resolved[0].resolved_path,
            current_dir
                .join("relative-scene-tests")
                .join("assets/character.glb")
        );
    }

    #[test]
    fn preserves_absolute_path_diagnostic() {
        let root = temp_path("absolute");
        let absolute = root.join("character.glb");
        let mut scene = valid_scene();
        scene.assets[0].path = absolute.to_string_lossy().into_owned();
        let scene_file = root.join("example.scene.json");
        let resolved = scene.resolve_asset_paths(&scene_file).expect("resolve");
        assert_eq!(resolved[0].kind, AssetPathKind::AbsoluteLocal);
        assert_eq!(resolved[0].stored_path, absolute);
        assert_eq!(resolved[0].resolved_path, absolute);
    }

    #[test]
    fn reports_missing_asset_separately() {
        let scene = valid_scene();
        let root = temp_path("missing");
        let scene_file = root.join("example.scene.json");
        let error = scene
            .check_resolved_assets(&scene_file)
            .expect_err("missing asset");
        assert!(matches!(error, SceneError::MissingAsset { .. }));
    }

    #[test]
    fn reports_scene_file_io_separately() {
        let missing = temp_path("missing-scene").join("example.scene.json");
        let error = Scene::load(missing).expect_err("missing scene");
        assert!(matches!(error, SceneError::FileIo { .. }));
    }

    #[test]
    fn empty_scene_is_valid_and_round_trips_through_save() {
        let root = temp_path("save-empty");
        fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("untitled.scene.json");
        let scene = Scene::empty("Untitled");
        scene.save(&path).expect("save empty scene");
        assert_eq!(Scene::load(&path).expect("reload empty scene"), scene);
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn save_as_rebases_relative_assets_to_the_new_parent() {
        let root = temp_path("save-as");
        let source = root.join("source").join("sample.scene.json");
        let target = root.join("saved").join("copy.scene.json");
        let scene = valid_scene();
        let rebased = scene
            .rebased_for_save(Some(&source), &target)
            .expect("rebase asset paths");
        assert_eq!(
            PathBuf::from(&rebased.assets[0].path),
            PathBuf::from("..").join("source/assets/character.glb")
        );
    }

    #[test]
    fn first_save_rebases_imported_absolute_asset() {
        let root = temp_path("first-save");
        let target = root.join("saved").join("copy.scene.json");
        let asset = root.join("assets").join("character.fbx");
        let mut scene = Scene::empty("Untitled");
        scene.assets.push(SceneAsset {
            id: "character".into(),
            kind: "fbx".into(),
            path: asset.to_string_lossy().into_owned(),
        });
        scene.instances.push(SceneInstance {
            id: "character-1".into(),
            asset: "character".into(),
            transform: SceneTransform {
                translation: [0.0; 3],
                rotation: [0.0, 0.0, 0.0, 1.0],
                scale: [1.0; 3],
            },
            visible: true,
        });

        let rebased = scene
            .rebased_for_save(None, &target)
            .expect("rebase first-save asset path");

        assert_eq!(
            PathBuf::from(&rebased.assets[0].path),
            PathBuf::from("..").join("assets/character.fbx")
        );
    }
}
