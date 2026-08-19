//! Persistent Scene JSON v1 types and validation.
//!
//! This module deliberately contains only the file-format boundary.  It does
//! not know about Tauri, Kiss3d, wgpu, or any renderer handles.  Runtime scene
//! construction belongs to a later integration slice.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

const SCENE_VERSION: u32 = 1;
const MAX_SCENE_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCENE_COLLECTION_ITEMS: usize = 4096;
const MAX_SCENE_ID_BYTES: usize = 1024;
const MAX_SCENE_NAME_BYTES: usize = 1024;
const MAX_SCENE_PATH_BYTES: usize = 4096;
const ATOMIC_TEMP_CREATE_ATTEMPTS: usize = 16;
static NEXT_ATOMIC_TEMP_ID: AtomicU64 = AtomicU64::new(1);

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
    InvalidAssetPath {
        asset_id: String,
        path: String,
    },
    StringTooLong {
        field: String,
        bytes: usize,
        limit: usize,
    },
    CollectionTooLarge {
        field: String,
        count: usize,
        limit: usize,
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
                let path = diagnostic_path(path);
                let message = diagnostic_text(message);
                write!(formatter, "scene file I/O failed for {}: {message}", path)
            }
            Self::Json { kind, message } => write!(
                formatter,
                "scene JSON {kind:?}: {}",
                diagnostic_text(message)
            ),
            Self::Validation(error) => write!(
                formatter,
                "scene validation failed: {}",
                diagnostic_text(&format!("{error:?}"))
            ),
            Self::MissingAsset {
                asset_id,
                resolved_path,
                path_kind,
                ..
            } => write!(
                formatter,
                "scene asset '{}' ({path_kind:?}) does not exist at {}",
                diagnostic_text(asset_id),
                diagnostic_path(resolved_path),
            ),
        }
    }
}

impl std::error::Error for SceneError {}

const MAX_DIAGNOSTIC_TEXT_BYTES: usize = 4096;

/// Keep user-controlled diagnostics single-line and bounded without changing
/// the stored Scene path or the path shown to successful callers.
pub(crate) fn diagnostic_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len().min(MAX_DIAGNOSTIC_TEXT_BYTES));
    for character in value.chars() {
        let replacement = match character {
            '\n' => "\\n".to_string(),
            '\r' => "\\r".to_string(),
            '\t' => "\\t".to_string(),
            character if is_bidi_control(character) => {
                format!("\\u{{{:x}}}", character as u32)
            }
            character if character.is_control() => format!("\\u{{{:x}}}", character as u32),
            character => character.to_string(),
        };
        if escaped.len() + replacement.len() > MAX_DIAGNOSTIC_TEXT_BYTES - 3 {
            escaped.push_str("...");
            break;
        }
        escaped.push_str(&replacement);
    }
    escaped
}

fn is_bidi_control(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{206f}'
    )
}

pub(crate) fn diagnostic_path(path: &Path) -> String {
    diagnostic_text(&path.to_string_lossy())
}

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
        if input.len() > MAX_SCENE_JSON_BYTES {
            return Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message: format!(
                    "scene JSON is {} bytes; maximum is {} bytes",
                    input.len(),
                    MAX_SCENE_JSON_BYTES
                ),
            });
        }
        if let Err(message) = reject_duplicate_json_keys(input) {
            return Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            });
        }
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
        let metadata = fs::metadata(path).map_err(|error| SceneError::FileIo {
            path: path.to_path_buf(),
            kind: error.kind(),
            message: error.to_string(),
        })?;
        if metadata.len() > MAX_SCENE_JSON_BYTES as u64 {
            return Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message: format!(
                    "scene JSON is {} bytes; maximum is {} bytes",
                    metadata.len(),
                    MAX_SCENE_JSON_BYTES
                ),
            });
        }
        let input = read_scene_json(path).map_err(|error| SceneError::FileIo {
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
        if encoded.len() > MAX_SCENE_JSON_BYTES {
            return Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message: format!(
                    "scene JSON is {} bytes; maximum is {} bytes",
                    encoded.len(),
                    MAX_SCENE_JSON_BYTES
                ),
            });
        }
        atomic_write(path, encoded.as_bytes()).map_err(|error| SceneError::FileIo {
            path: path.to_path_buf(),
            kind: error.kind(),
            message: format!("atomic Scene save failed: {error}"),
        })
    }

    /// Clone this document for a new Scene-file location while preserving the
    /// resolved targets of legacy relative paths. Absolute runtime-load paths
    /// are intentionally kept absolute across Save and Save As.
    pub fn rebased_for_save(
        &self,
        source_scene_file: Option<&Path>,
        target_scene_file: &Path,
    ) -> Result<Self, SceneError> {
        let Some(source_scene_file) = source_scene_file else {
            return Ok(self.clone());
        };
        let target_file = absolute_path(target_scene_file)?;
        let target_parent = target_file.parent().unwrap_or_else(|| Path::new("."));
        let canonical_target_parent = target_parent
            .canonicalize()
            .unwrap_or_else(|_| target_parent.to_path_buf());
        let mut rebased = self.clone();
        let resolved = self.resolve_asset_paths(source_scene_file)?;
        for (asset, resolved) in rebased.assets.iter_mut().zip(resolved) {
            if !is_absolute_asset_path(Path::new(&asset.path)) {
                let canonical_asset = resolved
                    .resolved_path
                    .canonicalize()
                    .unwrap_or(resolved.resolved_path);
                let rebased_path = pathdiff::diff_paths(&canonical_asset, &canonical_target_parent)
                    .unwrap_or(canonical_asset);
                asset.path = if rebased_path.is_absolute() {
                    rebased_path.to_string_lossy().into_owned()
                } else {
                    portable_relative_path(&rebased_path)
                };
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

        if let Some(name) = &self.name {
            validate_string_limit(name, "scene.name", MAX_SCENE_NAME_BYTES)?;
        }
        if self.assets.len() > MAX_SCENE_COLLECTION_ITEMS {
            return Err(SceneValidationError::CollectionTooLarge {
                field: "assets".to_string(),
                count: self.assets.len(),
                limit: MAX_SCENE_COLLECTION_ITEMS,
            });
        }
        if self.instances.len() > MAX_SCENE_COLLECTION_ITEMS {
            return Err(SceneValidationError::CollectionTooLarge {
                field: "instances".to_string(),
                count: self.instances.len(),
                limit: MAX_SCENE_COLLECTION_ITEMS,
            });
        }

        let mut asset_ids = std::collections::HashSet::with_capacity(self.assets.len());
        for (index, asset) in self.assets.iter().enumerate() {
            validate_string_limit(
                &asset.id,
                &format!("assets[{index}].id"),
                MAX_SCENE_ID_BYTES,
            )?;
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
            validate_string_limit(
                &asset.path,
                &format!("assets[{index}].path"),
                MAX_SCENE_PATH_BYTES,
            )?;
            if is_windows_drive_relative(Path::new(&asset.path)) {
                return Err(SceneValidationError::InvalidAssetPath {
                    asset_id: asset.id.clone(),
                    path: asset.path.clone(),
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
            validate_string_limit(
                &instance.id,
                &format!("instances[{index}].id"),
                MAX_SCENE_ID_BYTES,
            )?;
            if instance.id.trim().is_empty() {
                return Err(SceneValidationError::EmptyInstanceId { index });
            }
            if !instance_ids.insert(instance.id.clone()) {
                return Err(SceneValidationError::DuplicateInstanceId {
                    id: instance.id.clone(),
                });
            }
            validate_string_limit(
                &instance.asset,
                &format!("instances[{index}].asset"),
                MAX_SCENE_ID_BYTES,
            )?;
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
                let kind = if is_absolute_asset_path(&stored_path) {
                    AssetPathKind::AbsoluteLocal
                } else {
                    AssetPathKind::PortableRelative
                };
                let resolved_path = if kind == AssetPathKind::AbsoluteLocal {
                    stored_path.clone()
                } else {
                    scene_parent.join(portable_asset_path(&stored_path))
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

/// Read at most one byte beyond the JSON budget. The metadata check above is
/// only an early fast path; a concurrent writer can grow the file after it.
fn read_scene_json(path: &Path) -> io::Result<String> {
    let file = File::open(path)?;
    let mut input = String::new();
    file.take((MAX_SCENE_JSON_BYTES + 1) as u64)
        .read_to_string(&mut input)?;
    Ok(input)
}

const DUPLICATE_JSON_KEY_PREFIX: &str = "duplicate JSON object key: ";
const NESTING_JSON_KEY_PREFIX: &str = "scene JSON nesting exceeds ";
const MAX_SCENE_JSON_NESTING_DEPTH: usize = 256;

/// Scan JSON objects before schema deserialization so duplicate keys cannot
/// silently overwrite an earlier value. Syntax errors are left to the normal
/// parser below, which preserves serde_json's line/column diagnostics.
fn reject_duplicate_json_keys(input: &str) -> Result<(), String> {
    validate_json_nesting_depth(input)?;
    let mut deserializer = serde_json::Deserializer::from_str(input);
    match deserializer.deserialize_any(JsonValueVisitor { depth: 0 }) {
        Ok(()) => {
            let _ = deserializer.end();
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            if let Some(key) = message.strip_prefix(DUPLICATE_JSON_KEY_PREFIX) {
                Err(format!("{DUPLICATE_JSON_KEY_PREFIX}{key}"))
            } else if message.starts_with(NESTING_JSON_KEY_PREFIX) {
                Err(message)
            } else {
                Ok(())
            }
        }
    }
}

fn validate_json_nesting_depth(input: &str) -> Result<(), String> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in input.bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > MAX_SCENE_JSON_NESTING_DEPTH {
                    return Err(format!(
                        "{NESTING_JSON_KEY_PREFIX}{MAX_SCENE_JSON_NESTING_DEPTH}"
                    ));
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

struct JsonValueScanner {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for JsonValueScanner {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(JsonValueVisitor { depth: self.depth })
    }
}

struct JsonValueVisitor {
    depth: usize,
}

impl<'de> Visitor<'de> for JsonValueVisitor {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        if self.depth >= MAX_SCENE_JSON_NESTING_DEPTH {
            return Err(de::Error::custom(format!(
                "{NESTING_JSON_KEY_PREFIX}{MAX_SCENE_JSON_NESTING_DEPTH}"
            )));
        }
        let mut keys = std::collections::HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(de::Error::custom(format!(
                    "{DUPLICATE_JSON_KEY_PREFIX}{key}"
                )));
            }
            map.next_value_seed(JsonValueScanner {
                depth: self.depth + 1,
            })?;
        }
        Ok(())
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        if self.depth >= MAX_SCENE_JSON_NESTING_DEPTH {
            return Err(de::Error::custom(format!(
                "{NESTING_JSON_KEY_PREFIX}{MAX_SCENE_JSON_NESTING_DEPTH}"
            )));
        }
        while sequence
            .next_element_seed(JsonValueScanner {
                depth: self.depth + 1,
            })?
            .is_some()
        {}
        Ok(())
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        JsonValueScanner {
            depth: self.depth + 1,
        }
        .deserialize(deserializer)
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

/// Scene JSON uses forward slashes for relative paths on every platform.
/// Absolute paths retain their native spelling and are intentionally not
/// passed through this helper.
fn portable_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn portable_asset_path(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().replace('\\', "/"))
}

fn is_absolute_asset_path(path: &Path) -> bool {
    path.is_absolute() || is_windows_drive_absolute(path) || is_windows_unc(path)
}

fn is_windows_drive_absolute(path: &Path) -> bool {
    let value = path.to_string_lossy();
    let mut chars = value.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(drive), Some(':'), Some(separator))
            if drive.is_ascii_alphabetic() && matches!(separator, '\\' | '/')
    )
}

fn is_windows_drive_relative(path: &Path) -> bool {
    let value = path.to_string_lossy();
    let mut chars = value.chars();
    matches!((chars.next(), chars.next()), (Some(drive), Some(':'))
        if drive.is_ascii_alphabetic()
            && !matches!(chars.next(), Some('\\' | '/')))
}

fn is_windows_unc(path: &Path) -> bool {
    path.to_string_lossy().starts_with(r"\\")
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    atomic_write_with(path, contents, |temporary, destination| {
        fs::rename(temporary, destination)
    })
}

fn atomic_write_with<F>(destination: &Path, contents: &[u8], replace: F) -> io::Result<()>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let (mut file, temporary_path) = create_atomic_temp_file(destination)?;
    let mut cleanup = AtomicTempCleanup::new(temporary_path.clone());

    let write_result = (|| {
        file.write_all(contents)?;
        file.sync_all()
    })();
    drop(file);
    write_result?;

    replace(&temporary_path, destination)?;
    cleanup.committed = true;
    Ok(())
}

fn create_atomic_temp_file(destination: &Path) -> io::Result<(File, PathBuf)> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = destination.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Scene save destination must name a file",
        )
    })?;
    let stem = file_name.to_string_lossy();
    let process_id = std::process::id();

    for attempt in 0..ATOMIC_TEMP_CREATE_ATTEMPTS {
        let serial = NEXT_ATOMIC_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temporary_path = parent.join(format!(".{stem}.tmp-{process_id}-{serial}-{attempt}"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((file, temporary_path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary Scene save file",
    ))
}

struct AtomicTempCleanup {
    path: PathBuf,
    committed: bool,
}

impl AtomicTempCleanup {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }
}

impl Drop for AtomicTempCleanup {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
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

fn validate_string_limit(
    value: &str,
    field: &str,
    limit: usize,
) -> Result<(), SceneValidationError> {
    if value.len() > limit {
        Err(SceneValidationError::StringTooLong {
            field: field.to_string(),
            bytes: value.len(),
            limit,
        })
    } else {
        Ok(())
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

    fn atomic_temp_entries(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .expect("read temporary save directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".scene.json.tmp-"))
            })
            .collect()
    }

    #[test]
    fn parses_and_round_trips_semantically() {
        let scene = valid_scene();
        let encoded = serde_json::to_string(&scene).expect("serialize");
        let decoded = Scene::parse_json(&encoded).expect("round trip");
        assert_eq!(scene, decoded);
    }

    #[test]
    fn rejects_oversized_scene_json_before_deserialize() {
        let oversized = " ".repeat(MAX_SCENE_JSON_BYTES + 1);
        assert!(matches!(
            Scene::parse_json(&oversized),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            }) if message.contains("maximum")
        ));
    }

    #[test]
    fn rejects_excessively_nested_scene_json_before_schema_deserialize() {
        let mut nested = String::with_capacity(MAX_SCENE_JSON_NESTING_DEPTH * 2 + 1);
        nested.extend(std::iter::repeat_n('[', MAX_SCENE_JSON_NESTING_DEPTH + 1));
        nested.push('0');
        nested.extend(std::iter::repeat_n(']', MAX_SCENE_JSON_NESTING_DEPTH + 1));
        assert!(matches!(
            Scene::parse_json(&nested),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            }) if message.contains("nesting exceeds")
        ));
    }

    #[test]
    fn load_rejects_oversized_scene_file_before_reading() {
        let root = temp_path("oversized-load");
        fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("scene.json");
        fs::write(&path, vec![b' '; MAX_SCENE_JSON_BYTES + 1]).expect("write oversized fixture");
        assert!(matches!(
            Scene::load(&path),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            }) if message.contains("maximum")
        ));
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn bounded_scene_read_stops_after_budget_plus_one_byte() {
        let root = temp_path("bounded-read");
        fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("scene.json");
        fs::write(&path, vec![b' '; MAX_SCENE_JSON_BYTES + 4096]).expect("write oversized fixture");
        let input = read_scene_json(&path).expect("bounded read");
        assert_eq!(input.len(), MAX_SCENE_JSON_BYTES + 1);
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn rejects_scene_collection_and_string_limits() {
        let mut scene = valid_scene();
        scene.assets = (0..=MAX_SCENE_COLLECTION_ITEMS)
            .map(|index| SceneAsset {
                id: format!("asset-{index}"),
                kind: "gltf".to_string(),
                path: format!("asset-{index}.glb"),
            })
            .collect();
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::CollectionTooLarge { field, .. }) if field == "assets"
        ));

        let mut scene = valid_scene();
        scene.instances = (0..=MAX_SCENE_COLLECTION_ITEMS)
            .map(|index| {
                let mut instance = scene.instances[0].clone();
                instance.id = format!("instance-{index}");
                instance
            })
            .collect();
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::CollectionTooLarge { field, .. }) if field == "instances"
        ));

        let mut scene = valid_scene();
        scene.name = Some("n".repeat(MAX_SCENE_NAME_BYTES + 1));
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::StringTooLong { field, .. }) if field == "scene.name"
        ));

        let mut scene = valid_scene();
        scene.assets[0].id = "a".repeat(MAX_SCENE_ID_BYTES + 1);
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::StringTooLong { field, .. })
                if field == "assets[0].id"
        ));

        let mut scene = valid_scene();
        scene.assets[0].path = "p".repeat(MAX_SCENE_PATH_BYTES + 1);
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::StringTooLong { field, .. })
                if field == "assets[0].path"
        ));
    }

    #[test]
    fn rejects_serialized_scene_over_json_limit() {
        let mut scene = valid_scene();
        scene.instances.clear();
        scene.assets = (0..MAX_SCENE_COLLECTION_ITEMS)
            .map(|index| SceneAsset {
                id: format!("asset-{index}"),
                kind: "gltf".to_string(),
                path: "p".repeat(MAX_SCENE_PATH_BYTES),
            })
            .collect();
        let path = temp_path("oversized-json");
        assert!(matches!(
            scene.save(&path),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            }) if message.contains("maximum")
        ));
        assert!(!path.exists());
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
    fn rejects_duplicate_json_keys_at_any_object_depth() {
        let duplicate_top_level = r#"{"version":1,"version":1,"assets":[],"instances":[]}"#;
        assert!(matches!(
            Scene::parse_json(duplicate_top_level),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            }) if message.contains("duplicate JSON object key: version")
        ));

        let duplicate_nested = r#"{
            "version":1,
            "assets":[{"id":"asset","id":"other","kind":"gltf","path":"asset.glb"}],
            "instances":[]
        }"#;
        assert!(matches!(
            Scene::parse_json(duplicate_nested),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            }) if message.contains("duplicate JSON object key: id")
        ));

        let duplicate_escaped =
            r#"{"version":1,"name":"first","\u006eame":"second","assets":[],"instances":[]}"#;
        assert!(matches!(
            Scene::parse_json(duplicate_escaped),
            Err(SceneError::Json {
                kind: SceneJsonErrorKind::Schema,
                message,
            }) if message.contains("duplicate JSON object key: name")
        ));
    }

    #[test]
    fn diagnostics_escape_control_chars_and_bound_untrusted_text() {
        let error = SceneError::FileIo {
            path: PathBuf::from("scene\nname\twith-control"),
            kind: io::ErrorKind::Other,
            message: "read\r\nfailed".to_string(),
        };
        let message = error.to_string();
        assert!(!message.contains('\n'));
        assert!(!message.contains('\r'));
        assert!(message.contains("scene\\nname\\twith-control"));
        assert!(message.contains("read\\r\\nfailed"));

        let bidi = diagnostic_text("visible\u{202e}hidden");
        assert_eq!(bidi, "visible\\u{202e}hidden");
        assert_eq!(
            diagnostic_text("visible\u{206f}hidden"),
            "visible\\u{206f}hidden"
        );
        assert_eq!(
            diagnostic_path(Path::new("assets/visible\u{202e}hidden.glb")),
            "assets/visible\\u{202e}hidden.glb"
        );
        let bidi_long = diagnostic_text(&"\u{202e}".repeat(MAX_DIAGNOSTIC_TEXT_BYTES));
        assert!(bidi_long.len() <= MAX_DIAGNOSTIC_TEXT_BYTES);
        assert!(bidi_long.ends_with("..."));
        assert!(!bidi_long.contains('\u{202e}'));

        let long = diagnostic_text(&"x".repeat(MAX_DIAGNOSTIC_TEXT_BYTES + 32));
        assert!(long.len() <= MAX_DIAGNOSTIC_TEXT_BYTES);
        assert!(long.ends_with("..."));
        let unicode = diagnostic_text(&"é".repeat(MAX_DIAGNOSTIC_TEXT_BYTES));
        assert!(unicode.len() <= MAX_DIAGNOSTIC_TEXT_BYTES);
        assert!(unicode.ends_with("..."));
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
    fn rejects_windows_drive_relative_asset_paths() {
        let mut scene = valid_scene();
        scene.assets[0].path = "C:assets/character.glb".into();
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::InvalidAssetPath { path, .. })
                if path == "C:assets/character.glb"
        ));

        scene.assets[0].path = "C:".into();
        assert!(matches!(
            scene.validate(),
            Err(SceneValidationError::InvalidAssetPath { .. })
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
    fn resolves_legacy_windows_separators_as_portable_relative_paths() {
        let mut scene = valid_scene();
        scene.assets[0].path = r".\assets\character.glb".into();
        let root = temp_path("legacy-separators");
        let scene_file = root.join("experiments").join("example.scene.json");
        let resolved = scene.resolve_asset_paths(&scene_file).expect("resolve");
        assert_eq!(resolved[0].kind, AssetPathKind::PortableRelative);
        assert_eq!(
            resolved[0].resolved_path,
            root.join("experiments").join("assets/character.glb")
        );
    }

    #[test]
    fn preserves_foreign_windows_absolute_drive_and_unc_paths() {
        for path in [r"C:\assets\character.glb", r"\\server\share\character.glb"] {
            let mut scene = valid_scene();
            scene.assets[0].path = path.to_string();
            let resolved = scene
                .resolve_asset_paths(Path::new("portable/example.scene.json"))
                .expect("resolve foreign absolute path");
            assert_eq!(resolved[0].kind, AssetPathKind::AbsoluteLocal);
            assert_eq!(resolved[0].stored_path, PathBuf::from(path));
            assert_eq!(resolved[0].resolved_path, PathBuf::from(path));
        }
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
    fn save_replaces_existing_scene_file() {
        let root = temp_path("save-replace");
        fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("scene.json");
        fs::write(&path, b"old scene contents").expect("create existing scene");

        let scene = Scene::empty("Replacement");
        scene.save(&path).expect("replace existing scene");

        assert_eq!(
            Scene::load(&path)
                .expect("reload replacement")
                .name
                .as_deref(),
            Some("Replacement")
        );
        assert!(atomic_temp_entries(&root).is_empty());
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn injected_atomic_replace_failure_preserves_old_bytes_and_cleans_temp() {
        let root = temp_path("save-replace-failure");
        fs::create_dir_all(&root).expect("create temp directory");
        let path = root.join("scene.json");
        let old_contents = b"old scene contents";
        fs::write(&path, old_contents).expect("create existing scene");

        let error = atomic_write_with(&path, b"new scene contents", |_temporary, _destination| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected rename failure",
            ))
        })
        .expect_err("injected replacement must fail");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&path).expect("read preserved scene"), old_contents);
        assert!(atomic_temp_entries(&root).is_empty());
        fs::remove_dir_all(root).expect("remove temp directory");
    }

    #[test]
    fn missing_parent_save_reports_destination_and_leaves_no_temp_file() {
        let root = temp_path("save-missing-parent");
        let path = root.join("missing-parent").join("scene.json");

        let error = Scene::empty("Missing Parent")
            .save(&path)
            .expect_err("missing parent must fail");
        match error {
            SceneError::FileIo {
                path: error_path, ..
            } => assert_eq!(error_path, path),
            other => panic!("expected destination FileIo, got {other:?}"),
        }
        assert!(!root.exists());
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
        assert!(!rebased.assets[0].path.contains('\\'));
        assert_eq!(rebased.assets[0].path, "../source/assets/character.glb");
    }

    #[test]
    fn portable_relative_path_normalizes_windows_separators_only() {
        assert_eq!(
            portable_relative_path(Path::new(r"..\assets\character.glb")),
            "../assets/character.glb"
        );
        assert_eq!(
            portable_relative_path(Path::new("assets/character.glb")),
            "assets/character.glb"
        );
    }

    #[test]
    fn first_save_preserves_imported_absolute_asset() {
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

        assert_eq!(PathBuf::from(&rebased.assets[0].path), asset);
    }

    #[test]
    fn save_as_keeps_absolute_asset_path_native() {
        let root = temp_path("save-as-absolute");
        let target = root.join("saved").join("copy.scene.json");
        let asset = root.join("assets").join("character.fbx");
        let mut scene = Scene::empty("Untitled");
        scene.assets.push(SceneAsset {
            id: "character".into(),
            kind: "fbx".into(),
            path: asset.to_string_lossy().into_owned(),
        });

        let rebased = scene
            .rebased_for_save(Some(&root.join("source.scene.json")), &target)
            .expect("absolute path remains machine-local");
        assert_eq!(rebased.assets[0].path, asset.to_string_lossy());
    }

    #[test]
    fn save_as_preserves_foreign_windows_absolute_asset_spelling() {
        let root = temp_path("save-as-foreign-absolute");
        let target = root.join("saved").join("copy.scene.json");
        for path in [r"C:\assets\character.glb", r"\\server\share\character.glb"] {
            let mut scene = Scene::empty("Untitled");
            scene.assets.push(SceneAsset {
                id: "character".into(),
                kind: "gltf".into(),
                path: path.to_string(),
            });

            let rebased = scene
                .rebased_for_save(Some(&root.join("source.scene.json")), &target)
                .expect("foreign absolute path remains unchanged");
            assert_eq!(rebased.assets[0].path, path);
        }
    }
}
