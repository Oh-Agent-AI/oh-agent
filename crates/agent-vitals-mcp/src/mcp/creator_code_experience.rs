//! Code Game 体验包（Experience V2 的本地 P1 形态）。
//!
//! 一个作品包是**自包含**的：冻结的 `code/game.js` + 声明资产 + 权限/世界绑定 +
//! 每文件摘要 + `contentDigest`。发布（publish）只产出包；安装（install）先逐字节
//! 复核，再登记到本地内容库。这两步分开是刻意的：**装到库 ≠ 允许执行**，执行仍受
//! P0 可信本地 / P2 沙箱的信任级别约束。
//!
//! `contentDigest = sha256(canonicalJson(manifest 去掉 contentDigest))`，canonical
//! 形式是递归排序键；安装时用同一算法重算，任何字节被改都会 `game_package_integrity_failed`。
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::creator_code_workspace::{read_meta, workspace_dir};
use super::{ToolError, ToolSpec};

const MAX_VERSION: usize = 32;
const MAX_FILES: usize = 128;
const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;

fn spec(name: &'static str, description: &'static str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name,
        description,
        input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        output_schema: json!({"type":"object","properties":{"ok":{"type":"boolean"},"data":{"type":"object"}}}),
    }
}

pub fn specs() -> Vec<ToolSpec> {
    vec![
        spec(
            "creator_code_publish",
            "Package one immutable Code Game build into a self-contained local experience (bundle + declared assets + permissions + world binding + per-file digests + contentDigest). Publishing is not installation and is not a trust claim: it never executes code and never enables distribution. `permissionsAccepted` must be true. Requires `--allow-local-writes`.",
            json!({
                "workspaceId":{"type":"string","minLength":20,"maxLength":32},
                "buildId":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},
                "version":{"type":"string","minLength":1,"maxLength":32},
                "permissionsAccepted":{"type":"boolean"},
                "operationId":{"type":"string","minLength":1,"maxLength":128},
            }),
            &["workspaceId", "buildId", "permissionsAccepted"],
        ),
        spec(
            "creator_code_experience_list",
            "List published Code Game experience packages and which of them are registered in the local content library. Read-only; returns ids, versions, digests and byte counts, never filesystem paths.",
            json!({}),
            &[],
        ),
        spec(
            "creator_code_experience_install",
            "Install one published Code Game experience into the local content library after re-verifying the contentDigest and every file digest. Idempotent for the same digest; a different package under the same id+version is refused. Installation does not grant execution rights. Requires `--allow-local-writes`.",
            json!({
                "experienceId":{"type":"string","minLength":3,"maxLength":128},
                "version":{"type":"string","minLength":1,"maxLength":32},
            }),
            &["experienceId", "version"],
        ),
        spec(
            "creator_code_experience_uninstall",
            "Remove a Code Game experience from the local content library. The immutable package stays on disk for rollback/reinstall. Requires `--allow-local-writes`.",
            json!({
                "experienceId":{"type":"string","minLength":3,"maxLength":128},
                "version":{"type":"string","minLength":1,"maxLength":32},
            }),
            &["experienceId", "version"],
        ),
    ]
}

pub fn run(name: &str, args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    match name {
        "creator_code_experience_list" => list(data_home),
        "creator_code_publish" => {
            require_writes(allow_local_writes, "Publishing a Code Game experience")?;
            publish(args, data_home)
        }
        "creator_code_experience_install" => {
            require_writes(allow_local_writes, "Installing a Code Game experience")?;
            install(args, data_home)
        }
        "creator_code_experience_uninstall" => {
            require_writes(allow_local_writes, "Uninstalling a Code Game experience")?;
            uninstall(args, data_home)
        }
        other => Err(ToolError::new("internal_error", format!("tool `{other}` registered but not wired"))),
    }
}

fn require_writes(allowed: bool, action: &str) -> Result<(), ToolError> {
    if allowed {
        Ok(())
    } else {
        Err(ToolError::new("permission_denied", format!("{action} requires `data-mcp serve --allow-local-writes`.")))
    }
}

fn publish(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = required_str(args, "workspaceId", 32)?;
    let build_id = build_id_arg(args)?;
    if args.get("permissionsAccepted").and_then(Value::as_bool) != Some(true) {
        return Err(ToolError::new(
            "invalid_argument",
            "`permissionsAccepted` must be true; publishing an executable package requires explicit acknowledgement.",
        ));
    }
    let directory = workspace_dir(data_home, &workspace_id)?;
    let meta = read_meta(&directory)?;
    let build_dir = data_home.join("code-games").join("builds").join(&build_id);
    let game = read_json(&build_dir.join("manifest.json"))
        .ok_or_else(|| ToolError::new("data_unavailable", "The sealed build manifest is unavailable."))?;
    let version = match args.get("version").and_then(Value::as_str) {
        Some(value) => checked_version(value)?,
        None => checked_version(game.get("version").and_then(Value::as_str).unwrap_or("0.1.0"))?,
    };
    let bundle = data_home.join("code-games").join("builds").join(&build_id).join("game.js");
    if !bundle.is_file() {
        return Err(ToolError::new("not_found", "No built bundle for that buildId in this data home."));
    }

    let package = package_dir(data_home, &meta.game_id, &version)?;
    if package.exists() {
        std::fs::remove_dir_all(&package)
            .map_err(|_| ToolError::new("storage_unavailable", "Cannot replace the existing experience package."))?;
    }
    std::fs::create_dir_all(package.join("code"))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the experience directory."))?;
    std::fs::copy(&bundle, package.join("code").join("game.js"))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot copy the experience bundle."))?;

    let mut package_bytes = std::fs::metadata(package.join("code").join("game.js"))
        .map(|value| value.len())
        .unwrap_or(0);
    let mut assets = Vec::new();
    if let Some(items) = game.get("assets").and_then(Value::as_array) {
        for item in items {
            let Some(relative) = item.get("path").and_then(Value::as_str) else { continue };
            if !is_safe_relative(relative) {
                return Err(ToolError::new("invalid_argument", "The manifest contains an unsafe asset path."));
            }
            let source = build_dir.join(relative);
            if !source.is_file() {
                return Err(ToolError::new("game_asset_invalid", format!("Declared asset `{relative}` is missing.")));
            }
            let target = package.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the asset directory."))?;
            }
            std::fs::copy(&source, &target)
                .map_err(|_| ToolError::new("storage_unavailable", "Cannot copy a declared asset."))?;
            package_bytes += std::fs::metadata(&target).map(|value| value.len()).unwrap_or(0);
            assets.push(json!({"id": item.get("id").cloned().unwrap_or(Value::Null), "path": relative}));
        }
    }
    if package_bytes > MAX_PACKAGE_BYTES {
        return Err(ToolError::new("invalid_argument", "The package exceeds the 64 MiB byte budget."));
    }

    let permissions = game.get("permissions").cloned().unwrap_or_else(|| json!([]));
    let world = game.get("world").cloned().unwrap_or_else(|| json!({}));
    write_json(&package.join("permissions.json"), &json!({"permissions": permissions}))?;
    write_json(&package.join("world-binding.json"), &world)?;
    let build_record = read_json(&data_home.join("code-games").join("builds").join(&build_id).join("build.json"))
        .unwrap_or(Value::Null);
    let sdk_version = build_record.get("sdkVersion").and_then(Value::as_str).unwrap_or("unknown");
    write_json(
        &package.join("provenance.json"),
        &json!({
            "buildId": build_id,
            "gameRevision": meta.revision,
            "sdkVersion": sdk_version,
            "producedBy": "creator_code_publish",
            "createdAtMs": now_ms(),
        }),
    )?;

    let files = collect_package_files(&package)?;
    let mut manifest = json!({
        "schemaVersion": 1,
        "kind": "code-game-experience",
        "experienceId": meta.game_id,
        "gameId": meta.game_id,
        "gameVersion": version,
        "sdkApiMajor": game.get("sdk").and_then(|sdk| sdk.get("apiMajor")).cloned().unwrap_or(json!(1)),
        "buildId": build_id,
        "entry": "code/game.js",
        "permissions": permissions,
        "world": world,
        "assets": assets,
        "files": files,
    });
    let digest = sha256_hex(canonical_json(&manifest).as_bytes());
    manifest["contentDigest"] = json!(digest);
    write_json(&package.join("manifest.json"), &manifest)?;

    Ok(json!({"ok":true,"data":{
        "experienceId": meta.game_id,
        "version": version,
        "buildId": build_id,
        "contentDigest": digest,
        "fileCount": manifest["files"].as_array().map(Vec::len).unwrap_or(0),
        "byteLength": package_bytes,
        "installed": false,
    }}))
}

fn list(data_home: &Path) -> Result<Value, ToolError> {
    let library = read_library(data_home)?;
    let mut available = Vec::new();
    let experiences = data_home.join("code-games").join("experiences");
    if experiences.is_dir() {
        for game in std::fs::read_dir(&experiences).map_err(|_| ToolError::new("storage_unavailable", "Cannot read the experience store."))?.flatten() {
            if !game.path().is_dir() || available.len() >= 64 {
                continue;
            }
            for version in std::fs::read_dir(game.path()).map_err(|_| ToolError::new("storage_unavailable", "Cannot read an experience directory."))?.flatten() {
                if available.len() >= 64 {
                    break;
                }
                let manifest = read_json(&version.path().join("manifest.json"));
                if let Some(manifest) = manifest {
                    available.push(json!({
                        "experienceId": manifest.get("experienceId").cloned().unwrap_or(Value::Null),
                        "version": manifest.get("gameVersion").cloned().unwrap_or(Value::Null),
                        "buildId": manifest.get("buildId").cloned().unwrap_or(Value::Null),
                        "contentDigest": manifest.get("contentDigest").cloned().unwrap_or(Value::Null),
                        "installed": library.iter().any(|entry| {
                            entry.get("experienceId") == manifest.get("experienceId")
                                && entry.get("version") == manifest.get("gameVersion")
                        }),
                    }));
                }
            }
        }
    }
    Ok(json!({"ok":true,"data":{"installed":library,"available":available}}))
}

fn install(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let experience_id = required_str(args, "experienceId", 128)?;
    let version = checked_version(required_str(args, "version", MAX_VERSION)?.as_str())?;
    if !is_safe_identifier(&experience_id) {
        return Err(ToolError::new("invalid_argument", "`experienceId` is not a valid game id."));
    }
    let package = package_dir(data_home, &experience_id, &version)?;
    let manifest = read_json(&package.join("manifest.json"))
        .ok_or_else(|| ToolError::new("not_found", "No published experience for that id and version."))?;
    if manifest.get("kind").and_then(Value::as_str) != Some("code-game-experience") {
        return Err(ToolError::new("game_package_integrity_failed", "Not a code-game experience package."));
    }
    let declared = manifest.get("contentDigest").and_then(Value::as_str).map(ToString::to_string)
        .ok_or_else(|| ToolError::new("game_package_integrity_failed", "The package has no contentDigest."))?;
    let mut without_digest = manifest.clone();
    if let Some(object) = without_digest.as_object_mut() {
        object.remove("contentDigest");
    }
    let computed = sha256_hex(canonical_json(&without_digest).as_bytes());
    if computed != declared {
        return Err(ToolError::new("game_package_integrity_failed", "contentDigest does not match the package manifest."));
    }
    if let Some(files) = manifest.get("files").and_then(Value::as_array) {
        for file in files {
            let Some(relative) = file.get("path").and_then(Value::as_str) else {
                return Err(ToolError::new("game_package_integrity_failed", "A file entry has no path."));
            };
            if !is_safe_relative(relative) {
                return Err(ToolError::new("game_package_integrity_failed", "A file entry escapes the package."));
            }
            let path = package.join(relative);
            let bytes = std::fs::read(&path)
                .map_err(|_| ToolError::new("game_package_integrity_failed", format!("Missing file `{relative}`.")))?;
            if bytes.len() as u64 != file.get("bytes").and_then(Value::as_u64).unwrap_or(u64::MAX) {
                return Err(ToolError::new("game_package_integrity_failed", format!("Size mismatch for `{relative}`.")));
            }
            if sha256_hex(&bytes) != file.get("sha256").and_then(Value::as_str).unwrap_or("") {
                return Err(ToolError::new("game_package_integrity_failed", format!("Digest mismatch for `{relative}`.")));
            }
        }
    }

    let mut library = read_library(data_home)?;
    if let Some(existing) = library.iter().find(|entry| {
        entry.get("experienceId").and_then(Value::as_str) == Some(experience_id.as_str())
            && entry.get("version").and_then(Value::as_str) == Some(version.as_str())
    }) {
        if existing.get("contentDigest").and_then(Value::as_str) == Some(declared.as_str()) {
            return Ok(json!({"ok":true,"data":{
                "experienceId": experience_id, "version": version, "contentDigest": declared, "alreadyInstalled": true,
            }}));
        }
        return Err(ToolError::new(
            "game_package_integrity_failed",
            "A different package is already installed under this id and version; bump the version.",
        ));
    }
    library.push(json!({
        "experienceId": experience_id,
        "version": version,
        "contentDigest": declared,
        "installedAtMs": now_ms(),
    }));
    write_library(data_home, &library)?;
    Ok(json!({"ok":true,"data":{
        "experienceId": experience_id, "version": version, "contentDigest": declared, "alreadyInstalled": false,
    }}))
}

fn uninstall(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let experience_id = required_str(args, "experienceId", 128)?;
    let version = checked_version(required_str(args, "version", MAX_VERSION)?.as_str())?;
    let mut library = read_library(data_home)?;
    let before = library.len();
    library.retain(|entry| {
        !(entry.get("experienceId").and_then(Value::as_str) == Some(experience_id.as_str())
            && entry.get("version").and_then(Value::as_str) == Some(version.as_str()))
    });
    let removed = before != library.len();
    if removed {
        write_library(data_home, &library)?;
    }
    Ok(json!({"ok":true,"data":{"experienceId": experience_id, "version": version, "removed": removed}}))
}

// ── storage helpers ───────────────────────────────────────────────

fn package_dir(data_home: &Path, experience_id: &str, version: &str) -> Result<PathBuf, ToolError> {
    if !is_safe_identifier(experience_id) {
        return Err(ToolError::new("invalid_argument", "`experienceId` is not a valid game id."));
    }
    checked_version(version)?;
    Ok(data_home.join("code-games").join("experiences").join(experience_id).join(version))
}

fn write_json(path: &Path, value: &Value) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| ToolError::new("internal_error", "Cannot encode package JSON."))?;
    std::fs::write(path, bytes).map_err(|_| ToolError::new("storage_unavailable", "Cannot write a package file."))
}

fn collect_package_files(package: &Path) -> Result<Value, ToolError> {
    let mut files = Vec::new();
    collect_files(package, package, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    if files.len() > MAX_FILES {
        return Err(ToolError::new("invalid_argument", "The package exceeds the 128-file budget."));
    }
    let mut out = Vec::new();
    for (relative, path) in files {
        if relative == "manifest.json" {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|_| ToolError::new("storage_unavailable", "Cannot read a package file."))?;
        out.push(json!({"path": relative, "bytes": bytes.len(), "sha256": sha256_hex(&bytes)}));
    }
    Ok(json!(out))
}

fn collect_files(root: &Path, current: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), ToolError> {
    for entry in std::fs::read_dir(current).map_err(|_| ToolError::new("storage_unavailable", "Cannot read the package directory."))?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out)?;
        } else if path.is_file() {
            if let Ok(relative) = path.strip_prefix(root) {
                out.push((relative.to_string_lossy().replace('\\', "/"), path));
            }
        }
    }
    Ok(())
}

fn read_library(data_home: &Path) -> Result<Vec<Value>, ToolError> {
    let path = data_home.join("code-games").join("library.json");
    Ok(read_json(&path).and_then(|value| value.as_array().cloned()).unwrap_or_default())
}

fn write_library(data_home: &Path, library: &[Value]) -> Result<(), ToolError> {
    let root = data_home.join("code-games");
    std::fs::create_dir_all(&root).map_err(|_| ToolError::new("storage_unavailable", "Cannot create the content library."))?;
    let path = root.join("library.json");
    let temporary = root.join("library.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&json!(library)).map_err(|_| ToolError::new("internal_error", "Cannot encode the library."))?)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the content library."))?;
    std::fs::rename(&temporary, &path).map_err(|_| ToolError::new("storage_unavailable", "Cannot commit the content library."))
}

fn read_json(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

// ── identity / digest helpers ─────────────────────────────────────

fn is_safe_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && value.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn checked_version(value: &str) -> Result<String, ToolError> {
    if value.is_empty() || value.len() > MAX_VERSION
        || !value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
    {
        return Err(ToolError::new("invalid_argument", "`version` must be 1..32 identifier characters."));
    }
    Ok(value.to_string())
}

fn is_safe_relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.chars().any(|c| c.is_control())
        && value.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => canonical_object(map),
        Value::Array(items) => format!("[{}]", items.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn canonical_object(map: &Map<String, Value>) -> String {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    let body = keys
        .iter()
        .map(|key| format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), canonical_json(&map[*key])))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn required_str(args: &Value, key: &str, max: usize) -> Result<String, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max)
        .map(ToString::to_string)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required and must be at most {max} bytes")))
}

fn build_id_arg(args: &Value) -> Result<String, ToolError> {
    let value = required_str(args, "buildId", 64)?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(ToolError::new("invalid_argument", "`buildId` must be a 64-character lower-case hex digest"));
    }
    Ok(value)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys_deterministically() {
        let left = json!({"b": 1, "a": {"y": 2, "x": [3, {"d": 4, "c": 5}]}});
        let right = json!({"a": {"x": [3, {"c": 5, "d": 4}], "y": 2}, "b": 1});
        assert_eq!(canonical_json(&left), canonical_json(&right));
        assert_eq!(canonical_json(&left), r#"{"a":{"x":[3,{"c":5,"d":4}],"y":2},"b":1}"#);
    }

    #[test]
    fn identifiers_and_versions_reject_traversal_and_noise() {
        for id in ["commerce.tower-defense", "a", "community.x-1"] {
            assert!(is_safe_identifier(id), "{id}");
        }
        for id in ["../escape", "a/b", "", "a b"] {
            assert!(!is_safe_identifier(id), "{id}");
        }
        assert!(checked_version("0.1.0").is_ok());
        assert!(checked_version("../1").is_err());
        assert!(checked_version(&"1".repeat(33)).is_err());
    }

    #[test]
    fn safe_relative_paths_reject_escapes() {
        assert!(is_safe_relative("assets/cube.glb"));
        for path in ["../x", "/etc/passwd", "a/../../b", "C:/x", "a\\b", ""] {
            assert!(!is_safe_relative(path), "{path}");
        }
    }

    /// Publish→install→tamper→uninstall 契约：发布只产出包；安装逐字节复核；
    /// 任何字节被改都必须 `game_package_integrity_failed`；卸载只动库不动包。
    #[test]
    fn publish_install_tamper_and_uninstall_round_trip() {
        let home = std::env::temp_dir().join(format!("code-game-exp-{}-{}", now_ms(), std::process::id()));
        let workspace = home.join("code-games").join("workspaces").join("gws-0000000000000000");
        std::fs::create_dir_all(workspace.join("assets")).unwrap();
        write_json(&workspace.join("workspace.json"), &json!({
            "workspaceId": "gws-0000000000000000", "projectId": "prj", "gameId": "community.contract-test",
            "title": "Contract", "template": "checkpoint-race", "createdAtMs": 1, "revision": "r1",
        })).unwrap();
        write_json(&workspace.join("game.manifest.json"), &json!({
            "version": "1.2.3",
            "permissions": ["scene.read"],
            "world": {"generator": "arid-dunes-v1"},
            "assets": [{"id": "badge", "path": "assets/badge.json"}],
            "sdk": {"apiMajor": 1},
        })).unwrap();
        std::fs::write(workspace.join("assets").join("badge.json"), b"{\"ok\":true}").unwrap();
        let build_id = "a".repeat(64);
        let build = home.join("code-games").join("builds").join(&build_id);
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("game.js"), b"export default {};").unwrap();
        std::fs::create_dir_all(build.join("assets")).unwrap();
        std::fs::copy(workspace.join("game.manifest.json"), build.join("manifest.json")).unwrap();
        std::fs::copy(workspace.join("assets").join("badge.json"), build.join("assets").join("badge.json")).unwrap();
        write_json(&build.join("build.json"), &json!({"sdkVersion": "1.0.0"})).unwrap();

        // 发布：必须显式接受权限，且不落库。
        let publish_denied = run("creator_code_publish", &json!({"workspaceId": "gws-0000000000000000", "buildId": build_id}), &home, true).unwrap_err();
        assert_eq!(publish_denied.code, "invalid_argument");
        let published = run("creator_code_publish", &json!({
            "workspaceId": "gws-0000000000000000", "buildId": build_id, "permissionsAccepted": true,
        }), &home, true).unwrap();
        assert_eq!(published["data"]["version"], "1.2.3");
        assert_eq!(published["data"]["installed"], false);
        let digest = published["data"]["contentDigest"].as_str().unwrap().to_string();

        // 安装 + 幂等重装（同摘要）。
        let args = json!({"experienceId": "community.contract-test", "version": "1.2.3"});
        let installed = run("creator_code_experience_install", &args, &home, true).unwrap();
        assert_eq!(installed["data"]["alreadyInstalled"], false);
        assert_eq!(run("creator_code_experience_install", &args, &home, true).unwrap()["data"]["alreadyInstalled"], true);
        let listed = run("creator_code_experience_list", &json!({}), &home, true).unwrap();
        assert_eq!(listed["data"]["installed"].as_array().unwrap().len(), 1);
        assert_eq!(listed["data"]["available"][0]["installed"], true);

        // 卸载后篡改字节：重装必须按 per-file digest 拒绝。
        run("creator_code_experience_uninstall", &args, &home, true).unwrap();
        let package = home.join("code-games").join("experiences").join("community.contract-test").join("1.2.3");
        assert!(package.join("manifest.json").is_file(), "uninstall must keep the immutable package");
        std::fs::write(package.join("code").join("game.js"), b"export default 1;").unwrap();
        let tampered = run("creator_code_experience_install", &args, &home, true).unwrap_err();
        assert_eq!(tampered.code, "game_package_integrity_failed");

        // 修复字节但篡改 contentDigest 本身也要被拒。
        std::fs::write(package.join("code").join("game.js"), b"export default {};").unwrap();
        let mut forged = read_json(&package.join("manifest.json")).unwrap();
        forged["contentDigest"] = json!("f".repeat(64));
        write_json(&package.join("manifest.json"), &forged).unwrap();
        let forged_install = run("creator_code_experience_install", &args, &home, true).unwrap_err();
        assert_eq!(forged_install.code, "game_package_integrity_failed");

        // 同 id+version 换不同摘要的包必须拒绝，而不是静默替换。
        let mut swap = read_json(&package.join("manifest.json")).unwrap();
        swap["contentDigest"] = json!(digest);
        swap["permissions"] = json!(["scene.write"]);
        write_json(&package.join("manifest.json"), &swap).unwrap();
        let conflict = run("creator_code_experience_install", &args, &home, true).unwrap_err();
        assert_eq!(conflict.code, "game_package_integrity_failed");

        std::fs::remove_dir_all(&home).ok();
    }
}
