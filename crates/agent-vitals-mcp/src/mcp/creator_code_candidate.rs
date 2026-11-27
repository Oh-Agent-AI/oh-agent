//! Code Game 候选隔离层（PR09；重构方案 §6.2「Candidate Workspace 与源代码修改隔离」）。
//!
//! Agent 在用户确认前不得覆盖基线工作区：本模块让 Agent 的读写绑定
//! `candidateId + baseRevision`，落在 `<data_home>/state/creator/code-games/candidates/
//! <candidateId>/` 下的隔离树里；基线 `code-games/workspaces/<gws-…>` 只有
//! `creator_code_candidate_commit` 在 CAS 通过时才会被原子替换。一个 Candidate
//! 只能读到自己 fork 时刻的基线内容与自己的写入，绝不隐式读到另一个 Task 的
//! 未提交文件。
//!
//! 存储布局（每个候选一个目录；全是普通文件拷贝与目录 rename，不引入新依赖）：
//!
//! ```text
//! candidates/<candidateId>/
//!   candidate.json   — 候选记录（状态机 draft|building|testing|awaiting-review|accepted|rejected）
//!   tree/            — fork 时刻基线源码的完整副本（plain copy：规模上限与工作区一致，
//!                      ≤128 文件 / ≤64 MiB，重新 fork 廉价，不做增量/COW）
//!   baseline-pending/ — 仅在提交窗口/崩溃恢复期存在（被换下的旧基线树）
//!   commit.json      — 提交回执（换树成功后写入；重试按它重放，绝不二次换树）
//! candidate-operations/<operationId>.json — create 的幂等回执（PR02 模式）
//! ```
//!
//! **提交的崩溃恢复不变式**（本模块最重要的承诺）：
//!
//! 1. CAS 与换树都在「候选锁 → 基线锁」的固定顺序下进行（候选写只取候选锁、
//!    基线写只取基线锁，无环）；锁外只做读与参数校验。
//! 2. 换树 = `rename(workspaces/<id> → candidates/<cid>/baseline-pending)` 之后
//!    `rename(candidates/<cid>/tree → workspaces/<id>)`。tree 在换树前已写入完整的
//!    `workspace.json`（revision=候选摘要；摘要本身不含 workspace.json），因此两个
//!    rename 之间的崩溃窗口里，磁盘上要么是「基线旧（pending 在、工作区缺）」，
//!    要么是「基线新（工作区在）」——绝无半写目录。下一次 commit 先恢复：工作区缺
//!    → 补第二个 rename；工作区在 → 丢弃 pending，直接记账收尾。
//! 3. 回据 `commit.json` 在换树成功之后写入；回据之后的任何崩溃（状态更新、清理
//!    之前）由「回据存在 → 重放成功」覆盖：重试绝不二次换树，也绝不覆盖已被用户
//!    改动的基线。恢复只落在「未提交」或「已提交」之一。
//!
//! 其余边界（如实记录）：
//! - fork 是整树普通拷贝：`dist/`、`node_modules/`、`.git/` 等构建产物不入候选树，
//!   提交换树后基线里的构建产物目录按需重建（均可再生）。
//! - 候选写锁 `workspace-write-locks/candidate-<candidateId>.sqlite`（含同名
//!   `.pending` 暂存文件，与基线 file_write 同机制）与基线写锁并存；候选互相隔离。
//! - 每 workspace 至多 8 个候选目录；超限先清最老的终态（accepted/rejected）墓碑，
//!   仍超限则拒绝新建（`creator_candidate_limit`）——绝不静默删除活跃候选。
//! - `awaiting-review` 冻结候选树：file_write 拒绝、状态不再变化，保证 commit
//!   应用的就是被审阅的那份内容；重验证性质的 build/test 仍可运行（不改状态）。
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::creator_code_workspace::{
    canonical_json, digest_workspace, is_writable_text_path, list_files, now_ms, random_hex, read_meta,
    require_writes, required_str, resolve_inside, safe_relative_path, sha256_hex, valid_operation_id,
    workspace_dir, workspace_path, write_meta, MAX_FILES, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, MAX_TITLE,
    MAX_WRITE_BYTES, META_FILE,
};
use super::{ToolError, ToolSpec};

/// 每个工作区保留的候选目录上限（含终态墓碑）；超出先清最老的终态。
const MAX_CANDIDATES_PER_WORKSPACE: usize = 8;
/// 候选记录/回据 JSON 的读取预算（与工作区文件读预算同量级）。
const MAX_RECORD_BYTES: usize = 64 * 1024;
/// operationId 恢复扫描的目录上限：候选按 workspace 封顶 8，512 已覆盖 64 个工作区。
const MAX_RECOVERY_SCAN: usize = 512;

fn spec(name: &'static str, description: &'static str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name,
        description,
        input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        output_schema: json!({"type":"object","properties":{"ok":{"type":"boolean"},"data":{"type":"object"}}}),
    }
}

pub(crate) fn specs() -> Vec<ToolSpec> {
    vec![
        spec(
            "creator_code_candidate_create",
            "Fork the Code Game baseline workspace into an isolated candidate tree (a full copy under the MCP state area). Creating a candidate never changes the user's baseline; later file reads/writes bind to `candidateId` and the candidate revision. Optional `expectedBaseRevision` CAS-refuses when the live baseline digest differs. Optional `operationId` makes retries idempotent (same request replays the same candidate; a different payload is operation_id_conflict). Optional `title` labels the candidate. Requires `--allow-local-writes`.",
            json!({
                "workspaceId":{"type":"string","minLength":20,"maxLength":32},
                "expectedBaseRevision":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},
                "operationId":{"type":"string","minLength":1,"maxLength":128},
                "title":{"type":"string","minLength":1,"maxLength":80},
            }),
            &["workspaceId"],
        ),
        spec(
            "creator_code_candidate_status",
            "Read one Code Game candidate's record: status (draft|building|testing|awaiting-review|accepted|rejected), the fork base revision, the current candidate revision (recomputed from the candidate tree while it exists) and baseline drift (the live baseline digest versus the fork base). Read-only; never returns filesystem paths.",
            json!({"candidateId":{"type":"string","minLength":26,"maxLength":26,"pattern":"^candidate-[0-9a-f]{16}$"}}),
            &["candidateId"],
        ),
        spec(
            "creator_code_candidate_commit",
            "Commit a reviewed Code Game candidate onto its baseline workspace with CAS: refuses with creator_candidate_baseline_changed when the live baseline digest is not `expectedBaseRevision` (re-fork from the latest baseline instead); otherwise atomically replaces the baseline source tree with the exact candidate tree (crash-safe two-rename swap with recovery: a commit is either not committed or committed, never half-written) and marks the candidate accepted. Retries after a post-commit crash replay the same success without re-committing. Requires `--allow-local-writes`.",
            json!({
                "candidateId":{"type":"string","minLength":26,"maxLength":26,"pattern":"^candidate-[0-9a-f]{16}$"},
                "expectedBaseRevision":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},
            }),
            &["candidateId", "expectedBaseRevision"],
        ),
        spec(
            "creator_code_candidate_discard",
            "Discard a Code Game candidate: marks it rejected and deletes the isolated candidate tree. The user's baseline is never touched, and previously produced builds, tests and evidence stay available for diagnostics. Repeated discards are idempotent. Requires `--allow-local-writes`.",
            json!({"candidateId":{"type":"string","minLength":26,"maxLength":26,"pattern":"^candidate-[0-9a-f]{16}$"}}),
            &["candidateId"],
        ),
        spec(
            "creator_code_candidate_list",
            "List the Code Game candidates of one workspace (newest first; at most 8 candidate directories are retained per workspace). Read-only.",
            json!({"workspaceId":{"type":"string","minLength":20,"maxLength":32}}),
            &["workspaceId"],
        ),
        spec(
            "creator_code_candidate_submit",
            "Mark a Code Game candidate awaiting-review. Submitting never blocks on tests: the record carries an honest reviewBasis marker — tests-passed when the candidate's latest build has a headless test record with verdict passed, otherwise tests-failed / tests-inconclusive / untested. While awaiting-review the candidate tree is frozen (writes are refused) so the reviewed revision is exactly what commit later applies. Requires `--allow-local-writes`.",
            json!({"candidateId":{"type":"string","minLength":26,"maxLength":26,"pattern":"^candidate-[0-9a-f]{16}$"}}),
            &["candidateId"],
        ),
    ]
}

pub(crate) fn run(name: &str, args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    match name {
        "creator_code_candidate_status" => candidate_status(args, data_home),
        "creator_code_candidate_list" => candidate_list(args, data_home),
        "creator_code_candidate_create" => {
            require_writes(allow_local_writes, "Creating a Code Game candidate")?;
            candidate_create(args, data_home)
        }
        "creator_code_candidate_commit" => {
            require_writes(allow_local_writes, "Committing a Code Game candidate")?;
            candidate_commit(args, data_home)
        }
        "creator_code_candidate_discard" => {
            require_writes(allow_local_writes, "Discarding a Code Game candidate")?;
            candidate_discard(args, data_home)
        }
        "creator_code_candidate_submit" => {
            require_writes(allow_local_writes, "Submitting a Code Game candidate for review")?;
            candidate_submit(args, data_home)
        }
        other => Err(ToolError::new("internal_error", format!("tool `{other}` registered but not wired"))),
    }
}

// ── 候选记录 / 回据 ─────────────────────────────────────────────────

/// 一个候选的持久记录；`candidateRevision` 是最近一次已知的整树摘要投影
/// （每次候选读写/构建都会现场重算，落盘值只服务墓碑与列表投影）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CandidateRecord {
    #[serde(rename = "candidateId")]
    pub(crate) candidate_id: String,
    #[serde(rename = "workspaceId")]
    pub(crate) workspace_id: String,
    #[serde(rename = "baseRevision")]
    pub(crate) base_revision: String,
    pub(crate) status: String,
    #[serde(rename = "createdAtMs")]
    pub(crate) created_at_ms: u64,
    #[serde(rename = "candidateRevision")]
    pub(crate) candidate_revision: String,
    #[serde(rename = "operationId", default, skip_serializing_if = "Option::is_none")]
    pub(crate) operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    /// create 幂等的 requestHash（PR02 模式）：仅当带 operationId 时落盘，
    /// 供崩溃恢复判定「同一载荷」。
    #[serde(rename = "requestHash", default, skip_serializing_if = "Option::is_none")]
    pub(crate) request_hash: Option<String>,
    #[serde(rename = "lastBuildId", default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_build_id: Option<String>,
    #[serde(rename = "reviewBasis", default, skip_serializing_if = "Option::is_none")]
    pub(crate) review_basis: Option<String>,
    #[serde(rename = "submittedAtMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) submitted_at_ms: Option<u64>,
    #[serde(rename = "committedRevision", default, skip_serializing_if = "Option::is_none")]
    pub(crate) committed_revision: Option<String>,
    #[serde(rename = "rejectedAtMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) rejected_at_ms: Option<u64>,
}

/// `creator_code_candidate_create` 的幂等回据（PR02 模式）：重试按 requestHash
/// 重放原结果或拒绝（`operation_id_conflict`）。落盘在
/// `<data_home>/state/creator/code-games/candidate-operations/<operationId>.json`。
#[derive(Debug, Serialize, Deserialize)]
struct CandidateOperationReceipt {
    #[serde(rename = "operationId")]
    operation_id: String,
    #[serde(rename = "requestHash")]
    request_hash: String,
    #[serde(rename = "candidateId")]
    candidate_id: String,
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(rename = "baseRevision")]
    base_revision: String,
    #[serde(rename = "candidateRevision")]
    candidate_revision: String,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    status: String,
}

/// 提交回据：换树成功后写入 `candidates/<candidateId>/commit.json`。
/// candidateId 全局唯一，回据与记录里的 baseRevision 共同构成 (candidateId,
/// baseRevision) 的提交事实；重试看到回据即重放成功。
#[derive(Debug, Serialize, Deserialize)]
struct CommitReceipt {
    #[serde(rename = "candidateId")]
    candidate_id: String,
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(rename = "baseRevision")]
    base_revision: String,
    #[serde(rename = "committedRevision")]
    committed_revision: String,
    #[serde(rename = "committedAtMs")]
    committed_at_ms: u64,
}

// ── 路径 / id / 记录 IO ─────────────────────────────────────────────

fn candidates_root(data_home: &Path) -> PathBuf {
    data_home.join("state/creator/code-games").join("candidates")
}

fn candidate_dir(data_home: &Path, candidate_id: &str) -> PathBuf {
    candidates_root(data_home).join(candidate_id)
}

fn candidate_tree_path(data_home: &Path, candidate_id: &str) -> PathBuf {
    candidate_dir(data_home, candidate_id).join("tree")
}

fn pending_baseline_path(data_home: &Path, candidate_id: &str) -> PathBuf {
    candidate_dir(data_home, candidate_id).join("baseline-pending")
}

fn candidate_operations_dir(data_home: &Path) -> Result<PathBuf, ToolError> {
    let root = data_home.join("state/creator/code-games").join("candidate-operations");
    std::fs::create_dir_all(&root)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the candidate operation receipt directory."))?;
    Ok(root)
}

fn write_locks_dir(data_home: &Path) -> Result<PathBuf, ToolError> {
    let locks = data_home.join("code-games").join("workspace-write-locks");
    std::fs::create_dir_all(&locks)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the workspace write lock."))?;
    Ok(locks)
}

/// 与 workspaceId 同规则的候选 id 词表：`candidate-<16 hex>`（同时挡路径注入）。
pub(crate) fn valid_candidate_id(value: &str) -> bool {
    value.len() == 26
        && value.starts_with("candidate-")
        && value[10..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn candidate_id_arg(args: &Value) -> Result<String, ToolError> {
    let value = required_str(args, "candidateId", 26)?;
    if !valid_candidate_id(&value) {
        return Err(ToolError::new("invalid_argument", "`candidateId` must look like candidate-<16 hex>."));
    }
    Ok(value)
}

/// 带 candidateId 且不是显式 null 才走候选分支（与既有可选参数的缺席语义一致）。
fn has_candidate(args: &Value) -> bool {
    args.get("candidateId").map(|value| !value.is_null()).unwrap_or(false)
}

fn required_digest(args: &Value, key: &str) -> Result<String, ToolError> {
    let value = required_str(args, key, 64)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err(ToolError::new("invalid_argument", format!("`{key}` must be a 64-character lower-case hex digest")));
    }
    Ok(value)
}

fn optional_digest(args: &Value, key: &str) -> Result<Option<String>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => Ok(Some(required_digest(args, key)?)),
    }
}

fn optional_title(args: &Value) -> Result<Option<String>, ToolError> {
    match args.get("title") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() && value.len() <= MAX_TITLE => Ok(Some(value.clone())),
        Some(_) => Err(ToolError::new("invalid_argument", format!("`title` must be a string of 1..{MAX_TITLE} bytes"))),
    }
}

fn optional_operation_id(args: &Value) -> Result<Option<String>, ToolError> {
    match args.get("operationId") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid_operation_id(value) => Ok(Some(value.clone())),
        Some(_) => Err(ToolError::new(
            "invalid_argument",
            "`operationId` must be 1-128 characters: ASCII letters/digits (plus `_`/`-` after the first)",
        )),
    }
}

/// 读一条候选记录：缺失 → None；损坏/身份不符 → storage_unavailable。
fn read_record_at(directory: &Path) -> Result<Option<CandidateRecord>, ToolError> {
    let bytes = match std::fs::read(directory.join("candidate.json")) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(ToolError::new("data_unavailable", "The candidate record exceeds the read budget."));
    }
    let record: CandidateRecord = serde_json::from_slice(&bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "The candidate record is damaged."))?;
    if record.candidate_id != directory.file_name().and_then(|name| name.to_str()).unwrap_or_default() {
        return Err(ToolError::new("storage_unavailable", "The candidate record is damaged."));
    }
    Ok(Some(record))
}

fn read_candidate_record(data_home: &Path, candidate_id: &str) -> Result<Option<CandidateRecord>, ToolError> {
    read_record_at(&candidate_dir(data_home, candidate_id))
}

/// 原子写候选记录（tmp+rename；父目录可重建，配合 fork 记录先于树的顺序）。
fn write_candidate_record(data_home: &Path, candidate_id: &str, record: &CandidateRecord) -> Result<(), ToolError> {
    let directory = candidate_dir(data_home, candidate_id);
    std::fs::create_dir_all(&directory)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the candidate directory."))?;
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|_| ToolError::new("internal_error", "Cannot encode the candidate record."))?;
    let temporary = directory.join("candidate.json.tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the candidate record."))?;
    std::fs::rename(&temporary, directory.join("candidate.json"))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot publish the candidate record."))
}

/// 状态门：终态候选的一切内容操作都被结构化拒绝（墓碑 ≠ 不存在）。
fn gate_error(status: &str) -> ToolError {
    match status {
        "rejected" => ToolError::new(
            "creator_candidate_discarded",
            "This candidate was discarded; fork a new candidate from the latest baseline to continue.",
        ),
        _ => ToolError::new(
            "creator_candidate_committed",
            "This candidate was already committed to the baseline; read the baseline workspace instead.",
        ),
    }
}

fn load_active_candidate(data_home: &Path, candidate_id: &str) -> Result<CandidateRecord, ToolError> {
    let record = read_candidate_record(data_home, candidate_id)?
        .ok_or_else(|| ToolError::new("not_found", "No such Code Game candidate."))?;
    if matches!(record.status.as_str(), "accepted" | "rejected") {
        return Err(gate_error(&record.status));
    }
    Ok(record)
}

fn load_active_candidate_for_workspace(
    data_home: &Path,
    candidate_id: &str,
    workspace_id: &str,
) -> Result<CandidateRecord, ToolError> {
    let record = load_active_candidate(data_home, candidate_id)?;
    if record.workspace_id != workspace_id {
        return Err(ToolError::new("invalid_argument", "`candidateId` does not belong to this workspace."));
    }
    Ok(record)
}

/// 每次操作现场重算候选树摘要；树缺失是结构化不可用（记录与树应共存亡）。
fn candidate_revision(data_home: &Path, candidate_id: &str) -> Result<String, ToolError> {
    let tree = candidate_tree_path(data_home, candidate_id);
    if !tree.is_dir() {
        return Err(ToolError::new("data_unavailable", "The candidate source tree is missing."));
    }
    digest_workspace(&tree)
}

// ── fork：整树拷贝与中断恢复 ────────────────────────────────────────

/// 基线整树拷贝（跳过构建产物目录、瞬态 tmp 与 META_FILE；摘要两侧一致）。
fn copy_workspace_tree(source: &Path, target: &Path) -> Result<(), ToolError> {
    let mut copied = 0usize;
    copy_tree_entry(source, target, &mut copied)
}

fn copy_tree_entry(source: &Path, target: &Path, copied: &mut usize) -> Result<(), ToolError> {
    let entries = std::fs::read_dir(source)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot read the baseline workspace."))?;
    for entry in entries {
        let entry = entry.map_err(|_| ToolError::new("storage_unavailable", "Cannot read a baseline workspace entry."))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = entry
            .file_type()
            .map_err(|_| ToolError::new("storage_unavailable", "Cannot inspect a baseline workspace entry."))?;
        if kind.is_symlink() {
            return Err(ToolError::new("invalid_argument", "Symbolic links are not supported in Code Game workspaces."));
        }
        if kind.is_dir() {
            // 构建产物与 VCS 目录不入候选树；提交换树后按需重建。
            if matches!(name.as_str(), "dist" | "node_modules" | ".git") {
                continue;
            }
            let to = target.join(&name);
            std::fs::create_dir_all(&to)
                .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the candidate tree directory."))?;
            copy_tree_entry(&entry.path(), &to, copied)?;
        } else if kind.is_file() {
            // META_FILE 由提交阶段补写；瞬态 tmp 不参与摘要，跳过两侧摘要一致。
            if name == META_FILE || name == "workspace.json.tmp" {
                continue;
            }
            if *copied >= MAX_FILES {
                return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the file count budget."));
            }
            std::fs::copy(entry.path(), target.join(&name))
                .map_err(|_| ToolError::new("storage_unavailable", "Cannot copy the baseline workspace file."))?;
            *copied += 1;
        }
    }
    Ok(())
}

/// 保证候选树与记录一致：正常情况只做摘要复核；上次 fork 拷贝中断（树缺失或
/// 摘要不符且候选从未被写入）时整树重建。已有候选写入的树损坏时**不重建**
/// （重建会丢掉候选工作），如实报错。重建要求基线仍处于 baseRevision。
fn ensure_forked_tree(data_home: &Path, record: &CandidateRecord) -> Result<String, ToolError> {
    let tree = candidate_tree_path(data_home, &record.candidate_id);
    let virgin = record.candidate_revision == record.base_revision;
    if tree.is_dir() {
        if let Ok(digest) = digest_workspace(&tree) {
            if digest == record.candidate_revision {
                return Ok(digest);
            }
        }
        if !virgin {
            return Err(ToolError::new(
                "data_unavailable",
                "The candidate source tree does not match its recorded revision.",
            ));
        }
        std::fs::remove_dir_all(&tree)
            .map_err(|_| ToolError::new("storage_unavailable", "Cannot reset the interrupted candidate fork."))?;
    }
    let workspace_directory = workspace_dir(data_home, &record.workspace_id)?;
    let live = read_meta(&workspace_directory)?.revision;
    if live != record.base_revision {
        return Err(ToolError::new(
            "creator_candidate_baseline_changed",
            "The fork base is no longer the live baseline; discard the candidate and fork again from the latest baseline.",
        ));
    }
    std::fs::create_dir_all(&tree)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the candidate tree directory."))?;
    copy_workspace_tree(&workspace_directory, &tree)?;
    let digest = digest_workspace(&tree)?;
    if digest != record.base_revision {
        return Err(ToolError::new("data_unavailable", "The candidate fork does not match the baseline digest."));
    }
    Ok(digest)
}

// ── create（幂等 + 崩溃恢复 + 上限修剪）────────────────────────────

/// create 请求的幂等键：workspaceId + expectedBaseRevision + title（影响结果的
/// 请求字段；operationId 本身是回据的键，不进哈希）。
fn candidate_request_hash(workspace_id: &str, expected_base: Option<&str>, title: Option<&str>) -> String {
    sha256_hex(
        canonical_json(&json!({
            "expectedBaseRevision": expected_base,
            "title": title,
            "workspaceId": workspace_id,
        }))
        .as_bytes(),
    )
}

fn read_candidate_operation_receipt(root: &Path, operation_id: &str) -> Result<Option<CandidateOperationReceipt>, ToolError> {
    let bytes = match std::fs::read(root.join(format!("{operation_id}.json"))) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let receipt: CandidateOperationReceipt = serde_json::from_slice(&bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "The candidate operation receipt is damaged."))?;
    if receipt.operation_id != operation_id {
        return Err(ToolError::new("storage_unavailable", "The candidate operation receipt is damaged."));
    }
    Ok(Some(receipt))
}

fn write_candidate_operation_receipt(root: &Path, receipt: &CandidateOperationReceipt) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|_| ToolError::new("internal_error", "Cannot encode the candidate operation receipt."))?;
    let temporary = root.join(format!("{}.json.tmp", receipt.operation_id));
    std::fs::write(&temporary, bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the candidate operation receipt."))?;
    std::fs::rename(&temporary, root.join(format!("{}.json", receipt.operation_id)))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot publish the candidate operation receipt."))
}

/// 崩溃恢复扫描：按 operationId 找已落盘的候选记录（记录先于回据落盘）。
/// 有界目录扫描（512 个候选目录）足够覆盖本上限下的部署规模。
fn find_candidate_by_operation(data_home: &Path, operation_id: &str) -> Result<Option<CandidateRecord>, ToolError> {
    let root = candidates_root(data_home);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };
    let mut scanned = 0usize;
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        scanned += 1;
        if scanned > MAX_RECOVERY_SCAN {
            break;
        }
        if let Ok(Some(record)) = read_record_at(&entry.path()) {
            if record.operation_id.as_deref() == Some(operation_id) {
                return Ok(Some(record));
            }
        }
    }
    Ok(None)
}

/// 每 workspace 候选目录上限：先清终态墓碑（整目录删除——候选重 fork 廉价），
/// 活跃候选占满时拒绝新建，绝不静默删除活跃候选。无记录目录（fork 在写记录
/// 之前崩溃的空壳）一并回收；进行中的 fork 之后会重建父目录再写记录。
fn prune_candidates(data_home: &Path, workspace_id: &str) -> Result<(), ToolError> {
    let root = candidates_root(data_home);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    let mut mine: Vec<CandidateRecord> = Vec::new();
    let mut scanned = 0usize;
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        scanned += 1;
        if scanned > MAX_RECOVERY_SCAN {
            break;
        }
        match read_record_at(&entry.path()) {
            Ok(Some(record)) => {
                if record.workspace_id == workspace_id {
                    mine.push(record);
                }
            }
            // 无记录或损坏的目录没有可恢复的候选状态，删除是安全的。
            Ok(None) | Err(_) => {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    mine.sort_by_key(|record| record.created_at_ms);
    while mine.len() >= MAX_CANDIDATES_PER_WORKSPACE {
        let index = mine
            .iter()
            .position(|record| matches!(record.status.as_str(), "accepted" | "rejected"));
        match index {
            Some(index) => {
                let record = mine.remove(index);
                let _ = std::fs::remove_dir_all(candidate_dir(data_home, &record.candidate_id));
            }
            None => {
                return Err(ToolError::new(
                    "creator_candidate_limit",
                    format!(
                        "This workspace already has {MAX_CANDIDATES_PER_WORKSPACE} candidates; discard or commit one before forking another."
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn create_result(record: &CandidateRecord, candidate_revision: &str) -> Value {
    json!({"ok":true,"data":{
        "candidateId": record.candidate_id,
        "workspaceId": record.workspace_id,
        "baseRevision": record.base_revision,
        "candidateRevision": candidate_revision,
        "status": record.status,
    }})
}

fn create_result_from_receipt(receipt: &CandidateOperationReceipt) -> Value {
    json!({"ok":true,"data":{
        "candidateId": receipt.candidate_id,
        "workspaceId": receipt.workspace_id,
        "baseRevision": receipt.base_revision,
        "candidateRevision": receipt.candidate_revision,
        "status": receipt.status,
    }})
}

fn candidate_create(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = required_str(args, "workspaceId", 32)?;
    let expected_base = optional_digest(args, "expectedBaseRevision")?;
    let title = optional_title(args)?;
    let operation_id = optional_operation_id(args)?;
    let request_hash = candidate_request_hash(&workspace_id, expected_base.as_deref(), title.as_deref());
    let operations = candidate_operations_dir(data_home)?;

    // 幂等回据（PR02 模式）：同 operationId + 同载荷重放同一候选；不同载荷 conflict。
    if let Some(operation_id) = &operation_id {
        if let Some(receipt) = read_candidate_operation_receipt(&operations, operation_id)? {
            if receipt.request_hash == request_hash {
                return Ok(create_result_from_receipt(&receipt));
            }
            return Err(ToolError::new(
                "operation_id_conflict",
                "operationId was already used for a different candidate create request.",
            ));
        }
        // 崩溃恢复：candidate.json 已带该 operationId 但回据缺失 → 补齐候选树、
        // 补写回据并重放，绝不产生第二个候选。
        if let Some(record) = find_candidate_by_operation(data_home, operation_id)? {
            if record.request_hash.as_deref() == Some(request_hash.as_str()) {
                // 锁序与 commit 一致（候选锁 → 基线锁），避免与基线写互锁。
                let locks = write_locks_dir(data_home)?;
                let mut candidate_lock = rusqlite::Connection::open(locks.join(format!("candidate-{}.sqlite", record.candidate_id)))
                    .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the candidate write lock."))?;
                let _candidate_guard = candidate_lock
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|_| ToolError::new("busy", "Another write is in progress for this candidate."))?;
                let mut workspace_lock = rusqlite::Connection::open(locks.join(format!("{}.sqlite", record.workspace_id)))
                    .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the workspace write lock."))?;
                let _workspace_guard = workspace_lock
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|_| ToolError::new("busy", "Another write is in progress for this workspace."))?;
                ensure_forked_tree(data_home, &record)?;
                let receipt = CandidateOperationReceipt {
                    operation_id: operation_id.clone(),
                    request_hash,
                    candidate_id: record.candidate_id.clone(),
                    workspace_id: record.workspace_id.clone(),
                    base_revision: record.base_revision.clone(),
                    candidate_revision: record.candidate_revision.clone(),
                    created_at_ms: record.created_at_ms,
                    status: record.status.clone(),
                };
                write_candidate_operation_receipt(&operations, &receipt)?;
                return Ok(create_result_from_receipt(&receipt));
            }
            return Err(ToolError::new(
                "operation_id_conflict",
                "operationId was already used for a different candidate create request.",
            ));
        }
    }

    let directory = workspace_dir(data_home, &workspace_id)?;
    // fork 与基线写共用工作区写锁：读到的基线摘要与拷出的候选树之间不会被并发
    // 基线写穿插；同一工作区的并发 fork 也由此串行（prune 不会误删彼此的新目录）。
    let locks = write_locks_dir(data_home)?;
    let mut workspace_lock = rusqlite::Connection::open(locks.join(format!("{workspace_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the workspace write lock."))?;
    let _workspace_guard = workspace_lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this workspace."))?;
    let meta = read_meta(&directory)?;
    if let Some(expected) = &expected_base {
        if expected != &meta.revision {
            return Err(ToolError::new(
                "workspace_revision_conflict",
                "The baseline changed since you read it; re-read workspace info and retry with the current digest.",
            ));
        }
    }
    prune_candidates(data_home, &workspace_id)?;
    let candidate_id = format!("candidate-{}", random_hex(16));
    let record = CandidateRecord {
        candidate_id: candidate_id.clone(),
        workspace_id: workspace_id.clone(),
        base_revision: meta.revision.clone(),
        status: "draft".to_string(),
        created_at_ms: now_ms(),
        // fork 时刻候选树与基线同内容：摘要先按基线落盘（记录先于树的崩溃恢复
        // 顺序），整树拷贝完成后再由 ensure_forked_tree 复核。
        candidate_revision: meta.revision.clone(),
        operation_id: operation_id.clone(),
        title,
        request_hash: operation_id.as_ref().map(|_| request_hash.clone()),
        last_build_id: None,
        review_basis: None,
        submitted_at_ms: None,
        committed_revision: None,
        rejected_at_ms: None,
    };
    write_candidate_record(data_home, &candidate_id, &record)?;
    let candidate_revision = ensure_forked_tree(data_home, &record)?;
    if let Some(operation_id) = &operation_id {
        let receipt = CandidateOperationReceipt {
            operation_id: operation_id.clone(),
            request_hash,
            candidate_id: candidate_id.clone(),
            workspace_id,
            base_revision: record.base_revision.clone(),
            candidate_revision: candidate_revision.clone(),
            created_at_ms: record.created_at_ms,
            status: record.status.clone(),
        };
        write_candidate_operation_receipt(&operations, &receipt)?;
    }
    Ok(create_result(&record, &candidate_revision))
}

// ── 候选文件读写（PR09 扩展 creator_code_file_read / file_write）────

pub(crate) fn candidate_file_read(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = required_str(args, "workspaceId", 32)?;
    let candidate_id = candidate_id_arg(args)?;
    let relative = safe_relative_path(args)?;
    let record = load_active_candidate_for_workspace(data_home, &candidate_id, &workspace_id)?;
    let revision = candidate_revision(data_home, &candidate_id)?;
    let tree = candidate_tree_path(data_home, &candidate_id);
    let path = resolve_inside(&tree, &relative)?;
    let bytes = std::fs::read(&path).map_err(|_| ToolError::new("not_found", "No such file in this candidate."))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(ToolError::new("invalid_argument", "File exceeds the 64 KiB read budget."));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| ToolError::new("invalid_argument", "Only UTF-8 text files can be read."))?;
    Ok(json!({"ok":true,"data":{
        "workspaceId": record.workspace_id,
        "candidateId": record.candidate_id,
        "relativePath": relative,
        "gameRevision": revision,
        "candidateRevision": revision,
        "sha256": sha256_hex(content.as_bytes()),
        "content": content,
    }}))
}

pub(crate) fn candidate_file_write(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = required_str(args, "workspaceId", 32)?;
    let candidate_id = candidate_id_arg(args)?;
    let relative = safe_relative_path(args)?;
    if !is_writable_text_path(&relative) {
        return Err(ToolError::new("invalid_argument", "Only .ts/.tsx/.js/.mjs/.json/.md/.txt/.css/.html files can be written."));
    }
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`content` must be a string"))?;
    if content.len() > MAX_WRITE_BYTES {
        return Err(ToolError::new("invalid_argument", "Content exceeds the 256 KiB write budget."));
    }
    if relative
        .split('/')
        .any(|part| matches!(part, "dist" | "node_modules" | ".git" | META_FILE | ".code-game-tsconfig.json"))
    {
        return Err(ToolError::new("invalid_argument", "Workspace metadata is host-owned and cannot be written."));
    }
    // 候选写锁：两个对同一候选的写在此串行；候选互不隔离冲突，也绝不取基线写锁
    // （基线在提交前不允许被候选触碰）。
    let locks = write_locks_dir(data_home)?;
    let mut lock = rusqlite::Connection::open(locks.join(format!("candidate-{candidate_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the candidate write lock."))?;
    let _write_lock = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this candidate."))?;
    let record = load_active_candidate_for_workspace(data_home, &candidate_id, &workspace_id)?;
    if record.status == "awaiting-review" {
        return Err(ToolError::new(
            "creator_candidate_locked_for_review",
            "This candidate is awaiting review and its tree is frozen; discard it or commit it.",
        ));
    }
    let tree = candidate_tree_path(data_home, &candidate_id);
    let current = candidate_revision(data_home, &candidate_id)?;
    if let Some(expected) = args.get("expectedRevision").and_then(Value::as_str) {
        if expected != current {
            return Err(ToolError::new(
                "workspace_revision_conflict",
                "The candidate changed since you read it; re-read the file and retry.",
            ));
        }
    }
    let path = resolve_inside(&tree, &relative)?;
    let files = list_files(&tree)?;
    let existing_size = files.iter().find(|(name, _)| name == &relative).map(|(_, size)| *size);
    if existing_size.is_none() && files.len() >= MAX_FILES {
        return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the file count budget."));
    }
    let new_size = files.iter().map(|(_, size)| *size).sum::<u64>() - existing_size.unwrap_or(0) + content.len() as u64;
    if new_size > MAX_SNAPSHOT_BYTES {
        return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the build input byte budget."));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the target directory."))?;
    }
    // 与基线 file_write 同机制：先暂存到锁目录旁的同名 .pending，再原子 rename。
    let staged_file = locks.join(format!("candidate-{candidate_id}.pending"));
    std::fs::write(&staged_file, content.as_bytes())
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot stage the candidate file."))?;
    std::fs::rename(&staged_file, &path)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the candidate file."))?;
    let revision = digest_workspace(&tree)?;
    let mut record = record;
    record.candidate_revision = revision.clone();
    write_candidate_record(data_home, &candidate_id, &record)?;
    Ok(json!({"ok":true,"data":{
        "workspaceId": record.workspace_id,
        "candidateId": record.candidate_id,
        "relativePath": relative,
        "gameRevision": revision,
        "candidateRevision": revision,
        "sha256": sha256_hex(content.as_bytes()),
    }}))
}

// ── build / test 对接（creator_code_workspace 的候选分支）──────────

/// build() 的候选解析产物：候选树路径 + 现场重算的候选摘要。
#[derive(Debug)]
pub(crate) struct CandidateBuildTarget {
    pub(crate) candidate_id: String,
    pub(crate) tree: PathBuf,
    pub(crate) revision: String,
}

/// test() 的候选解析产物：buildId 必须密封该候选的摘要。
#[derive(Debug)]
pub(crate) struct CandidateTestTarget {
    pub(crate) candidate_id: String,
    pub(crate) revision: String,
}

/// build() 的可选候选分支：args 带 candidateId 时解析活跃候选并重算树摘要；
/// 不带时返回 None（基线路径原样）。candidateId 形状/归属错误是 invalid_argument。
pub(crate) fn build_target(args: &Value, data_home: &Path, workspace_id: &str) -> Result<Option<CandidateBuildTarget>, ToolError> {
    if !has_candidate(args) {
        return Ok(None);
    }
    let candidate_id = candidate_id_arg(args)?;
    load_active_candidate_for_workspace(data_home, &candidate_id, workspace_id)?;
    let revision = candidate_revision(data_home, &candidate_id)?;
    Ok(Some(CandidateBuildTarget {
        tree: candidate_tree_path(data_home, &candidate_id),
        candidate_id,
        revision,
    }))
}

/// test() 的可选候选分支：buildId 密封的 sourceRevision 必须是
/// `candidate:<candidateId>:<digest>` 且与候选归属一致，否则拒绝。
pub(crate) fn test_target(
    args: &Value,
    data_home: &Path,
    workspace_id: &str,
    build_id: &str,
    game_id: &str,
) -> Result<Option<CandidateTestTarget>, ToolError> {
    if !has_candidate(args) {
        return Ok(None);
    }
    let candidate_id = candidate_id_arg(args)?;
    load_active_candidate_for_workspace(data_home, &candidate_id, workspace_id)?;
    let revision = build_candidate_revision(data_home, build_id, &candidate_id, game_id)?;
    Ok(Some(CandidateTestTarget { candidate_id, revision }))
}

/// 候选构建的身份解析（build_workspace_revision 的 candidate 形态）：密封的
/// sourceRevision 必须是 `candidate:<candidateId>:<64hex>` 且 buildId/gameId 一致。
pub(crate) fn build_candidate_revision(
    data_home: &Path,
    build_id: &str,
    candidate_id: &str,
    game_id: &str,
) -> Result<String, ToolError> {
    use std::io::Read;
    let directory = data_home.join("code-games").join("builds").join(build_id);
    if !directory.join("game.js").is_file() || !directory.join("manifest.json").is_file() {
        return Err(ToolError::new("not_found", "No sealed build for that buildId in this data home."));
    }
    let file = std::fs::File::open(directory.join("build.json"))
        .map_err(|_| ToolError::new("not_found", "The sealed build record is unavailable."))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ToolError::new("game_build_failed", "Cannot read the sealed build record."))?;
    let record: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ToolError::new("game_build_failed", "The sealed build record is malformed."))?;
    let prefix = format!("candidate:{candidate_id}:");
    let revision = record["sourceRevision"]
        .as_str()
        .and_then(|source| source.strip_prefix(&prefix))
        .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    if let Some(revision) = revision {
        if bytes.len() <= MAX_FILE_BYTES && record["buildId"] == build_id && record["gameId"] == game_id {
            return Ok(revision.to_owned());
        }
    }
    Err(ToolError::new(
        "workspace_build_mismatch",
        "This build is not attributed to this candidate. Build the candidate again and use the returned buildId.",
    ))
}

/// build/test 运行前的状态推进：终态候选拒绝；awaiting-review 冻结状态不变
/// （重验证运行不改状态）；活跃候选单调推进 draft/building/testing。
pub(crate) fn mark_status(data_home: &Path, candidate_id: &str, target: &str) -> Result<(), ToolError> {
    let locks = write_locks_dir(data_home)?;
    let mut lock = rusqlite::Connection::open(locks.join(format!("candidate-{candidate_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the candidate write lock."))?;
    let _guard = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this candidate."))?;
    let record = load_active_candidate(data_home, candidate_id)?;
    if record.status == target || record.status == "awaiting-review" {
        return Ok(());
    }
    let mut record = record;
    record.status = target.to_string();
    write_candidate_record(data_home, candidate_id, &record)
}

/// 成功构建后记录候选的最新 buildId（身份链 candidateId → digest → buildId）。
pub(crate) fn note_build(data_home: &Path, candidate_id: &str, build_id: &str) -> Result<(), ToolError> {
    let locks = write_locks_dir(data_home)?;
    let mut lock = rusqlite::Connection::open(locks.join(format!("candidate-{candidate_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the candidate write lock."))?;
    let _guard = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this candidate."))?;
    let mut record = load_active_candidate(data_home, candidate_id)?;
    record.last_build_id = Some(build_id.to_string());
    write_candidate_record(data_home, candidate_id, &record)
}

// ── status / list / submit ──────────────────────────────────────────

fn candidate_status(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let candidate_id = candidate_id_arg(args)?;
    let record = read_candidate_record(data_home, &candidate_id)?
        .ok_or_else(|| ToolError::new("not_found", "No such Code Game candidate."))?;
    // 树在 → 现场重算摘要（记录值只是投影）；树不在（终态）→ 用记录值。
    let candidate_revision = if candidate_tree_path(data_home, &candidate_id).is_dir() {
        digest_workspace(&candidate_tree_path(data_home, &candidate_id))?
    } else {
        record.candidate_revision.clone()
    };
    // 基线漂移：live 基线摘要 vs fork 时的 baseRevision。工作区被删 → null。
    let drift = match workspace_dir(data_home, &record.workspace_id) {
        Ok(directory) => {
            let live = read_meta(&directory)?.revision;
            json!({"baselineRevision": live, "drifted": live != record.base_revision})
        }
        Err(_) => json!({"baselineRevision": Value::Null, "drifted": Value::Null}),
    };
    let mut data = json!({
        "candidateId": record.candidate_id,
        "workspaceId": record.workspace_id,
        "status": record.status,
        "baseRevision": record.base_revision,
        "candidateRevision": candidate_revision,
        "createdAtMs": record.created_at_ms,
        "treePresent": candidate_tree_path(data_home, &candidate_id).is_dir(),
        "drift": drift,
    });
    let object = data.as_object_mut().expect("status data is an object");
    if let Some(title) = &record.title {
        object.insert("title".into(), json!(title));
    }
    if let Some(operation_id) = &record.operation_id {
        object.insert("operationId".into(), json!(operation_id));
    }
    if let Some(build_id) = &record.last_build_id {
        object.insert("lastBuildId".into(), json!(build_id));
    }
    if let Some(basis) = &record.review_basis {
        object.insert("reviewBasis".into(), json!(basis));
    }
    if let Some(at) = record.submitted_at_ms {
        object.insert("submittedAtMs".into(), json!(at));
    }
    if let Some(revision) = &record.committed_revision {
        object.insert("committedRevision".into(), json!(revision));
    }
    if let Some(at) = record.rejected_at_ms {
        object.insert("rejectedAtMs".into(), json!(at));
    }
    Ok(json!({"ok":true,"data":data}))
}

fn candidate_list(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = required_str(args, "workspaceId", 32)?;
    let root = candidates_root(data_home);
    let mut items: Vec<CandidateRecord> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        let mut scanned = 0usize;
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            scanned += 1;
            if scanned > MAX_RECOVERY_SCAN {
                break;
            }
            if let Ok(Some(record)) = read_record_at(&entry.path()) {
                if record.workspace_id == workspace_id {
                    items.push(record);
                }
            }
        }
    }
    items.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms).then(left.candidate_id.cmp(&right.candidate_id)));
    let candidates: Vec<Value> = items
        .iter()
        .map(|record| {
            let mut item = json!({
                "candidateId": record.candidate_id,
                "status": record.status,
                "baseRevision": record.base_revision,
                "candidateRevision": record.candidate_revision,
                "createdAtMs": record.created_at_ms,
            });
            let object = item.as_object_mut().expect("list item is an object");
            if let Some(title) = &record.title {
                object.insert("title".into(), json!(title));
            }
            if let Some(build_id) = &record.last_build_id {
                object.insert("lastBuildId".into(), json!(build_id));
            }
            item
        })
        .collect();
    let total = candidates.len();
    Ok(json!({"ok":true,"data":{"workspaceId":workspace_id,"candidates":candidates,"total":total}}))
}

/// submit 的诚实标记：不阻塞提交，但 reviewBasis 如实反映最新构建的无头测试
/// 结论（tests-passed / tests-failed / tests-inconclusive / untested）。
fn review_basis_for(data_home: &Path, record: &CandidateRecord) -> String {
    let Some(build_id) = &record.last_build_id else {
        return "untested".to_string();
    };
    let bytes = match std::fs::read(
        data_home
            .join("state/creator/code-games")
            .join("tests")
            .join(format!("{build_id}.json")),
    ) {
        Ok(bytes) => bytes,
        Err(_) => return "untested".to_string(),
    };
    let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
        return "tests-inconclusive".to_string();
    };
    match record.get("verdict").and_then(Value::as_str) {
        Some("passed") => "tests-passed".to_string(),
        Some("failed") => "tests-failed".to_string(),
        _ => "tests-inconclusive".to_string(),
    }
}

fn candidate_submit(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let candidate_id = candidate_id_arg(args)?;
    let locks = write_locks_dir(data_home)?;
    let mut lock = rusqlite::Connection::open(locks.join(format!("candidate-{candidate_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the candidate write lock."))?;
    let _guard = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this candidate."))?;
    let mut record = load_active_candidate(data_home, &candidate_id)?;
    let basis = review_basis_for(data_home, &record);
    record.status = "awaiting-review".to_string();
    record.review_basis = Some(basis.clone());
    record.submitted_at_ms = Some(now_ms());
    write_candidate_record(data_home, &candidate_id, &record)?;
    Ok(json!({"ok":true,"data":{
        "candidateId": record.candidate_id,
        "workspaceId": record.workspace_id,
        "status": record.status,
        "reviewBasis": basis,
        "candidateRevision": record.candidate_revision,
    }}))
}

// ── discard / commit ────────────────────────────────────────────────

fn candidate_discard(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let candidate_id = candidate_id_arg(args)?;
    let locks = write_locks_dir(data_home)?;
    let mut lock = rusqlite::Connection::open(locks.join(format!("candidate-{candidate_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the candidate write lock."))?;
    let _guard = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this candidate."))?;
    let record = read_candidate_record(data_home, &candidate_id)?
        .ok_or_else(|| ToolError::new("not_found", "No such Code Game candidate."))?;
    if record.status == "accepted" {
        return Err(gate_error(&record.status));
    }
    if record.status != "rejected" {
        // 状态门先落盘（重复 discard 幂等）：门生效后树删除是纯回收，失败留给
        // 后续重试/修剪。
        let mut record = record.clone();
        record.status = "rejected".to_string();
        record.rejected_at_ms = Some(now_ms());
        write_candidate_record(data_home, &candidate_id, &record)?;
    }
    let _ = std::fs::remove_dir_all(candidate_tree_path(data_home, &candidate_id));
    let record = read_candidate_record(data_home, &candidate_id)?.expect("discard rewrote the record");
    Ok(json!({"ok":true,"data":{
        "candidateId": record.candidate_id,
        "workspaceId": record.workspace_id,
        "status": record.status,
        "rejectedAtMs": record.rejected_at_ms,
    }}))
}

fn read_commit_receipt(data_home: &Path, candidate_id: &str) -> Result<Option<CommitReceipt>, ToolError> {
    let bytes = match std::fs::read(candidate_dir(data_home, candidate_id).join("commit.json")) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let receipt: CommitReceipt = serde_json::from_slice(&bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "The commit receipt is damaged."))?;
    if receipt.candidate_id != candidate_id {
        return Err(ToolError::new("storage_unavailable", "The commit receipt is damaged."));
    }
    Ok(Some(receipt))
}

fn write_commit_receipt(data_home: &Path, receipt: &CommitReceipt) -> Result<(), ToolError> {
    let directory = candidate_dir(data_home, &receipt.candidate_id);
    let bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|_| ToolError::new("internal_error", "Cannot encode the commit receipt."))?;
    let temporary = directory.join("commit.json.tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the commit receipt."))?;
    std::fs::rename(&temporary, directory.join("commit.json"))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot publish the commit receipt."))
}

/// 提交收尾（幂等）：记录置 accepted + 回据事实，清理 pending（旧基线）与残留
/// 候选树。回据已存在时重试走到这里也只是重复同样的事实。
fn finalize_committed(data_home: &Path, record: &CandidateRecord, receipt: &CommitReceipt) -> Result<(), ToolError> {
    let mut record = record.clone();
    record.status = "accepted".to_string();
    record.committed_revision = Some(receipt.committed_revision.clone());
    write_candidate_record(data_home, &record.candidate_id, &record)?;
    let _ = std::fs::remove_dir_all(pending_baseline_path(data_home, &record.candidate_id));
    let _ = std::fs::remove_dir_all(candidate_tree_path(data_home, &record.candidate_id));
    Ok(())
}

fn commit_result(receipt: &CommitReceipt) -> Value {
    json!({"ok":true,"data":{
        "candidateId": receipt.candidate_id,
        "workspaceId": receipt.workspace_id,
        "status": "accepted",
        "baseRevision": receipt.base_revision,
        "committedRevision": receipt.committed_revision,
        "baselineRevision": receipt.committed_revision,
        "committedAtMs": receipt.committed_at_ms,
    }})
}

fn candidate_commit(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let candidate_id = candidate_id_arg(args)?;
    let expected_base = required_digest(args, "expectedBaseRevision")?;
    if !candidate_dir(data_home, &candidate_id).is_dir() {
        return Err(ToolError::new("not_found", "No such Code Game candidate."));
    }
    // 锁序固定：候选锁 → 基线锁（候选写只取候选锁、基线写只取基线锁，无环）。
    let locks = write_locks_dir(data_home)?;
    let mut candidate_lock = rusqlite::Connection::open(locks.join(format!("candidate-{candidate_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the candidate write lock."))?;
    let _candidate_guard = candidate_lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this candidate."))?;
    let record = read_candidate_record(data_home, &candidate_id)?
        .ok_or_else(|| ToolError::new("not_found", "No such Code Game candidate."))?;
    if record.status == "rejected" {
        return Err(gate_error(&record.status));
    }
    let workspace_id = record.workspace_id.clone();
    let mut workspace_lock = rusqlite::Connection::open(locks.join(format!("{workspace_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the workspace write lock."))?;
    let _workspace_guard = workspace_lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this workspace."))?;
    let workspace_directory = workspace_path(data_home, &workspace_id)?;
    let tree = candidate_tree_path(data_home, &candidate_id);
    let pending = pending_baseline_path(data_home, &candidate_id);

    // 1) 回据重放：已提交过的重试返回同一结果，绝不二次换树，也绝不碰可能已被
    //    用户改动的基线（content CAS 已由上一次调用完成）。
    if let Some(receipt) = read_commit_receipt(data_home, &candidate_id)? {
        finalize_committed(data_home, &record, &receipt)?;
        return Ok(commit_result(&receipt));
    }
    // 2) 崩溃恢复：baseline-pending 存在说明上一次尝试已通过 CAS、正在换树。
    //    工作区缺 → 补第二个 rename（tree 已含完整 workspace.json）；工作区在 →
    //    换树已完成，丢弃 pending 直接记账。恢复只落在「未提交/已提交」之一。
    if pending.is_dir() {
        if !workspace_directory.is_dir() {
            std::fs::rename(&tree, &workspace_directory)
                .map_err(|_| ToolError::new("storage_unavailable", "Cannot complete the interrupted candidate commit."))?;
        }
        // 防御：换树完成的工作区必须带 workspace.json（正常顺序里 tree 在换树前
        // 已补写 meta）。异常缺失时从 pending（旧基线）取 identity 补写。
        if !workspace_directory.join(META_FILE).is_file() {
            let mut meta = read_meta(&pending)?;
            meta.revision = record.candidate_revision.clone();
            write_meta(&workspace_directory, &meta)?;
        }
        let live = digest_workspace(&workspace_directory)?;
        if live != record.candidate_revision {
            return Err(ToolError::new(
                "data_unavailable",
                "The interrupted commit left an inconsistent baseline; the candidate digest does not match.",
            ));
        }
        let receipt = CommitReceipt {
            candidate_id: candidate_id.clone(),
            workspace_id,
            base_revision: record.base_revision.clone(),
            committed_revision: record.candidate_revision.clone(),
            committed_at_ms: now_ms(),
        };
        write_commit_receipt(data_home, &receipt)?;
        finalize_committed(data_home, &record, &receipt)?;
        return Ok(commit_result(&receipt));
    }
    if record.status == "accepted" {
        return Err(ToolError::new(
            "data_unavailable",
            "The candidate is marked accepted but has no commit receipt; the local state is inconsistent.",
        ));
    }
    // 3) CAS：live 基线摘要必须等于调用方声明的 expectedBaseRevision，且必须仍是
    //    fork 时的 baseRevision；任一不符 → 拒绝并要求基于最新基线重新 fork。
    if !workspace_directory.is_dir() {
        return Err(ToolError::new("not_found", "No such Code Game workspace."));
    }
    let live = digest_workspace(&workspace_directory)?;
    if live != expected_base {
        return Err(ToolError::new(
            "creator_candidate_baseline_changed",
            "The baseline changed since you read it; re-read workspace info and retry with the current digest.",
        ));
    }
    if expected_base != record.base_revision {
        return Err(ToolError::new(
            "creator_candidate_baseline_changed",
            "The baseline changed since this candidate was forked; discard it and fork a new candidate from the latest baseline.",
        ));
    }
    if !tree.is_dir() {
        return Err(ToolError::new("data_unavailable", "The candidate source tree is missing."));
    }
    let candidate_revision = digest_workspace(&tree)?;
    // 4) 暂存：tree 先补上完整 workspace.json（identity 取 live 基线，revision=
    //    候选摘要；摘要不含 workspace.json，树内容不变），使 tree 成为完整的
    //    基线工作区目录。
    let mut meta = read_meta(&workspace_directory)?;
    meta.revision = candidate_revision.clone();
    write_meta(&tree, &meta)?;
    // 5) 换树：两个 rename 之间的任何崩溃都落在可恢复状态（模块头不变式）。
    std::fs::rename(&workspace_directory, &pending)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot stage the baseline swap."))?;
    std::fs::rename(&tree, &workspace_directory)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot publish the candidate as the baseline."))?;
    // 6) 回据先于记录状态落盘（重试重放依赖回据）。
    let receipt = CommitReceipt {
        candidate_id: candidate_id.clone(),
        workspace_id,
        base_revision: expected_base,
        committed_revision: candidate_revision,
        committed_at_ms: now_ms(),
    };
    write_commit_receipt(data_home, &receipt)?;
    finalize_committed(data_home, &record, &receipt)?;
    Ok(commit_result(&receipt))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 基线工作区夹具：src/index.ts + game.manifest.json + host 元数据；
    /// 返回 fork 前的基线摘要。
    fn fixture_workspace(home: &Path, workspace_id: &str) -> String {
        let workspace = home.join("code-games/workspaces").join(workspace_id);
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(workspace.join("src/index.ts"), "export default 0;\n").unwrap();
        std::fs::write(workspace.join("game.manifest.json"), r#"{"gameId":"community.test"}"#).unwrap();
        let revision = digest_workspace(&workspace).unwrap();
        write_meta(
            &workspace,
            &super::super::creator_code_workspace::WorkspaceMeta {
                workspace_id: workspace_id.into(),
                project_id: "project-test".into(),
                game_id: "community.test".into(),
                title: "Test".into(),
                template: "hello-city".into(),
                created_at_ms: 1,
                revision: revision.clone(),
                operation_id: None,
            },
        )
        .unwrap();
        revision
    }

    fn try_create(home: &Path, workspace_id: &str, extra: Value) -> Result<Value, ToolError> {
        let mut args = json!({"workspaceId": workspace_id});
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                args[key.as_str()] = value.clone();
            }
        }
        candidate_create(&args, home)
    }

    fn create(home: &Path, workspace_id: &str, extra: Value) -> Value {
        try_create(home, workspace_id, extra).unwrap()
    }

    fn write_candidate(home: &Path, workspace_id: &str, candidate_id: &str, path: &str, content: &str, expected: &str) -> Result<Value, ToolError> {
        candidate_file_write(
            &json!({
                "workspaceId": workspace_id,
                "candidateId": candidate_id,
                "relativePath": path,
                "content": content,
                "expectedRevision": expected,
            }),
            home,
        )
    }

    fn baseline_digest(home: &Path, workspace_id: &str) -> String {
        digest_workspace(&home.join("code-games/workspaces").join(workspace_id)).unwrap()
    }

    fn candidate_ids(home: &Path) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(candidates_root(home)) else {
            return Vec::new();
        };
        let mut ids = Vec::new();
        for entry in entries.flatten() {
            if entry.file_type().unwrap().is_dir() {
                ids.push(entry.file_name().to_string_lossy().to_string());
            }
        }
        ids.sort();
        ids
    }

    /// candidateId 词表：形状/大小写/路径注入全部拒绝。
    #[test]
    fn candidate_ids_reject_wrong_shapes() {
        for id in ["candidate-ZZ", "candidate-", "candidate-123", "../escape", "candidate-0000000000000000extra", ""] {
            assert!(!valid_candidate_id(id), "accepted {id}");
        }
        assert!(valid_candidate_id("candidate-0123456789abcdef"));
        let args = json!({"candidateId": "candidate-0123456789abcdef"});
        assert!(candidate_id_arg(&args).is_ok());
        assert_eq!(candidate_id_arg(&json!({"candidateId": 7})).unwrap_err().code, "invalid_argument");
    }

    /// fork 不触碰基线：目录数不变、摘要不变；candidateRevision 与 baseRevision
    /// 相同（整树拷贝）；不带 candidateId 的基线读行为保持原样。
    #[test]
    fn fork_does_not_touch_the_baseline() {
        let home = std::env::temp_dir().join(format!("code-game-cand-fork-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        assert_eq!(created["data"]["status"], "draft");
        assert_eq!(created["data"]["baseRevision"], base);
        assert_eq!(created["data"]["candidateRevision"], base);
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        assert!(candidate_id.starts_with("candidate-"));
        assert_eq!(candidate_ids(&home), vec![candidate_id.clone()]);
        assert_eq!(baseline_digest(&home, workspace_id), base);
        // 基线读不受影响（candidateId 缺席 → 原样）。
        let read = super::super::creator_code_workspace::file_read(
            &json!({"workspaceId": workspace_id, "relativePath": "src/index.ts"}),
            &home,
        )
        .unwrap();
        assert_eq!(read["data"]["gameRevision"], base);
        // 候选读带 candidateId：同一文件同内容，revision 是候选摘要。
        let candidate_read = candidate_file_read(
            &json!({"workspaceId": workspace_id, "candidateId": candidate_id, "relativePath": "src/index.ts"}),
            &home,
        )
        .unwrap();
        assert_eq!(candidate_read["data"]["content"], "export default 0;\n");
        assert_eq!(candidate_read["data"]["candidateRevision"], base);
        assert!(home.join("state/creator/code-games/candidates").join(&candidate_id).join("tree").join("src/index.ts").is_file());
        assert!(!home.join("state/creator/code-games/candidates").join(&candidate_id).join("tree").join("workspace.json").exists());
        std::fs::remove_dir_all(home).ok();
    }

    /// 同 operationId + 同载荷重放同一候选；不同载荷 conflict；回据丢失后重试
    /// 走记录恢复补写回据；拷贝中断（树摘要不符）也能恢复。
    #[test]
    fn create_is_idempotent_per_operation_id() {
        let home = std::env::temp_dir().join(format!("code-game-cand-op-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        fixture_workspace(&home, workspace_id);
        let first = create(&home, workspace_id, json!({"operationId": "op-cand-1", "title": "Fix drift"}));
        let second = create(&home, workspace_id, json!({"operationId": "op-cand-1", "title": "Fix drift"}));
        assert_eq!(first, second);
        let conflict = try_create(&home, workspace_id, json!({"operationId": "op-cand-1", "title": "Other"})).unwrap_err();
        assert_eq!(conflict.code, "operation_id_conflict");
        let candidate_id = first["data"]["candidateId"].as_str().unwrap().to_string();
        // 回据丢失（回据写盘前崩溃）→ 记录恢复补写回据并重放同一候选。
        std::fs::remove_file(
            home
                .join("state/creator/code-games/candidate-operations")
                .join("op-cand-1.json"),
        )
        .unwrap();
        let recovered = create(&home, workspace_id, json!({"operationId": "op-cand-1", "title": "Fix drift"}));
        assert_eq!(recovered["data"]["candidateId"], candidate_id);
        assert!(home
            .join("state/creator/code-games/candidate-operations")
            .join("op-cand-1.json")
            .is_file());
        // 同 operationId 换工作区也是 conflict。
        let other = "gws-1111111111111111";
        fixture_workspace(&home, other);
        let other_conflict = try_create(&home, other, json!({"operationId": "op-cand-1"})).unwrap_err();
        assert_eq!(other_conflict.code, "operation_id_conflict");
        std::fs::remove_dir_all(home).ok();
    }

    /// fork 的 CAS：expectedBaseRevision 与 live 基线摘要不符 → workspace_revision_conflict，
    /// 且不产生候选目录。
    #[test]
    fn create_cas_refuses_a_stale_expected_base() {
        let home = std::env::temp_dir().join(format!("code-game-cand-cas-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        fixture_workspace(&home, workspace_id);
        let stale = "0".repeat(64);
        let error = candidate_create(
            &json!({"workspaceId": workspace_id, "expectedBaseRevision": stale, "operationId": "op-cas-1"}),
            &home,
        )
        .unwrap_err();
        assert_eq!(error.code, "workspace_revision_conflict");
        assert!(candidate_ids(&home).is_empty());
        assert!(!home.join("state/creator/code-games/candidate-operations/op-cas-1.json").exists());
        std::fs::remove_dir_all(home).ok();
    }

    /// 候选写 CAS：陈旧 expectedRevision → workspace_revision_conflict；并发写同一
    /// 候选在同一 expected 下恰好一个成功（候选写锁串行化）。
    #[test]
    fn candidate_writes_cas_and_serialize() {
        let home = std::env::temp_dir().join(format!("code-game-cand-write-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        let stale = write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "x", &"f".repeat(64)).unwrap_err();
        assert_eq!(stale.code, "workspace_revision_conflict");
        let results = std::thread::scope(|scope| {
            let write = |content: &'static str| {
                write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", content, &base)
            };
            let first = scope.spawn(move || write("export default 1;"));
            let second = scope.spawn(move || write("export default 2;"));
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let winner = results.iter().find_map(|result| result.as_ref().ok()).unwrap();
        let tree = candidates_root(&home).join(&candidate_id).join("tree");
        assert_eq!(winner["data"]["sha256"], sha256_hex(&std::fs::read(tree.join("src/index.ts")).unwrap()));
        let revision = winner["data"]["candidateRevision"].as_str().unwrap().to_string();
        assert_eq!(revision, digest_workspace(&tree).unwrap());
        // 记录的投影同步更新；基线纹丝不动。
        let record = read_candidate_record(&home, &candidate_id).unwrap().unwrap();
        assert_eq!(record.candidate_revision, revision);
        assert_eq!(baseline_digest(&home, workspace_id), base);
        std::fs::remove_dir_all(home).ok();
    }

    /// 候选隔离：两个候选互不可见对方的文件；基线编辑不进入已 fork 的候选；
    /// 候选写不触碰基线摘要。
    #[test]
    fn candidates_are_isolated_from_each_other_and_the_baseline() {
        let home = std::env::temp_dir().join(format!("code-game-cand-iso-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let first = create(&home, workspace_id, json!({}))["data"]["candidateId"].as_str().unwrap().to_string();
        let second = create(&home, workspace_id, json!({}))["data"]["candidateId"].as_str().unwrap().to_string();
        assert_ne!(first, second);
        write_candidate(&home, workspace_id, &first, "src/only-c1.ts", "one;", &base).unwrap();
        write_candidate(&home, workspace_id, &second, "src/only-c2.ts", "two;", &base).unwrap();
        // 各自能看到自己的新文件。
        let own = candidate_file_read(&json!({"workspaceId": workspace_id, "candidateId": first, "relativePath": "src/only-c1.ts"}), &home).unwrap();
        assert_eq!(own["data"]["content"], "one;");
        // 对方的新文件不可见（不隐式读到另一个 Task 的未提交文件）。
        assert_eq!(
            candidate_file_read(&json!({"workspaceId": workspace_id, "candidateId": first, "relativePath": "src/only-c2.ts"}), &home)
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(
            candidate_file_read(&json!({"workspaceId": workspace_id, "candidateId": second, "relativePath": "src/only-c1.ts"}), &home)
                .unwrap_err()
                .code,
            "not_found"
        );
        // 基线既看不到候选文件，摘要也未被候选写改动。
        let baseline = super::super::creator_code_workspace::file_read(&json!({"workspaceId": workspace_id, "relativePath": "src/only-c1.ts"}), &home);
        assert_eq!(baseline.unwrap_err().code, "not_found");
        assert_eq!(baseline_digest(&home, workspace_id), base);
        // fork 之后基线编辑不进入候选：候选读到的仍是 fork 时刻内容。
        super::super::creator_code_workspace::file_write(
            &json!({"workspaceId": workspace_id, "relativePath": "src/index.ts", "content": "export default 9;", "expectedRevision": base}),
            &home,
        )
        .unwrap();
        let drifted_base = baseline_digest(&home, workspace_id);
        assert_ne!(drifted_base, base);
        let candidate_view = candidate_file_read(&json!({"workspaceId": workspace_id, "candidateId": first, "relativePath": "src/index.ts"}), &home).unwrap();
        assert_eq!(candidate_view["data"]["content"], "export default 0;\n");
        // candidateId 与 workspaceId 不匹配 → invalid_argument。
        let mismatch = candidate_file_read(&json!({"workspaceId": "gws-1111111111111111", "candidateId": first, "relativePath": "src/index.ts"}), &home);
        assert_eq!(mismatch.unwrap_err().code, "invalid_argument");
        std::fs::remove_dir_all(home).ok();
    }

    /// 提交 happy path：基线树与 meta.revision 等于候选摘要、候选置 accepted、
    /// 回据落盘；提交后改动基线再重试 → 同一成功重放，基线不被二次改动。
    #[test]
    fn commit_applies_the_candidate_and_replays_without_double_commit() {
        let home = std::env::temp_dir().join(format!("code-game-cand-commit-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        let written = write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 1;", &base).unwrap();
        let candidate_revision = written["data"]["candidateRevision"].as_str().unwrap().to_string();
        let committed = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home).unwrap();
        assert_eq!(committed["data"]["status"], "accepted");
        assert_eq!(committed["data"]["committedRevision"], candidate_revision);
        let workspace = home.join("code-games/workspaces").join(workspace_id);
        assert_eq!(std::fs::read_to_string(workspace.join("src/index.ts")).unwrap(), "export default 1;");
        assert_eq!(read_meta(&workspace).unwrap().revision, candidate_revision);
        assert_eq!(baseline_digest(&home, workspace_id), candidate_revision);
        let record = read_candidate_record(&home, &candidate_id).unwrap().unwrap();
        assert_eq!(record.status, "accepted");
        assert_eq!(record.committed_revision.as_deref(), Some(candidate_revision.as_str()));
        assert!(candidate_dir(&home, &candidate_id).join("commit.json").is_file());
        assert!(!candidate_dir(&home, &candidate_id).join("tree").exists(), "the candidate tree became the baseline");
        // 篡改基线后重试同一 commit → 成功重放，基线内容保持用户改动后的样子。
        super::super::creator_code_workspace::file_write(
            &json!({"workspaceId": workspace_id, "relativePath": "src/index.ts", "content": "export default 2;", "expectedRevision": candidate_revision}),
            &home,
        )
        .unwrap();
        let tampered = baseline_digest(&home, workspace_id);
        let replay = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home).unwrap();
        assert_eq!(replay, committed);
        assert_eq!(baseline_digest(&home, workspace_id), tampered, "replay must not re-swap or overwrite the baseline");
        // 提交后的候选内容操作被结构化拒绝。
        assert_eq!(
            candidate_file_read(&json!({"workspaceId": workspace_id, "candidateId": candidate_id, "relativePath": "src/index.ts"}), &home)
                .unwrap_err()
                .code,
            "creator_candidate_committed"
        );
        std::fs::remove_dir_all(home).ok();
    }

    /// fork 后基线被编辑 → commit 以 creator_candidate_baseline_changed 拒绝；
    /// 基线与候选都不被改动，候选仍是 draft。
    #[test]
    fn commit_refuses_when_the_baseline_drifted() {
        let home = std::env::temp_dir().join(format!("code-game-cand-drift-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 1;", &base).unwrap();
        // 基线在 fork 之后前进。
        super::super::creator_code_workspace::file_write(
            &json!({"workspaceId": workspace_id, "relativePath": "src/extra.ts", "content": "export const a = 1;", "expectedRevision": base}),
            &home,
        )
        .unwrap();
        let drifted = baseline_digest(&home, workspace_id);
        let error = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home).unwrap_err();
        assert_eq!(error.code, "creator_candidate_baseline_changed");
        assert_eq!(baseline_digest(&home, workspace_id), drifted, "a refused commit must not touch the baseline");
        let record = read_candidate_record(&home, &candidate_id).unwrap().unwrap();
        assert_eq!(record.status, "draft");
        assert!(candidate_dir(&home, &candidate_id).join("tree").is_dir());
        // 提交方声明的摘要与 fork 基线不一致（基线已前进）→ 同一结构化拒绝。
        let stale_call = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": drifted}), &home).unwrap_err();
        assert_eq!(stale_call.code, "creator_candidate_baseline_changed");
        std::fs::remove_dir_all(home).ok();
    }

    /// 崩溃窗口 A（两个 rename 之间）：工作区缺、pending 在、tree 完整 → 下一次
    /// commit 先补第二个 rename 再记账；结果与未崩溃的提交完全一致。
    #[test]
    fn commit_recovers_a_swap_interrupted_between_renames() {
        let home = std::env::temp_dir().join(format!("code-game-cand-crash-a-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        let written = write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 1;", &base).unwrap();
        let candidate_revision = written["data"]["candidateRevision"].as_str().unwrap().to_string();
        // 忠实模拟真实崩溃顺序：commit 先把完整 workspace.json 暂存进 tree（step 4），
        // rename A 完成、rename B 未发生。tree 是完整的基线工作区目录。
        let workspace_directory = home.join("code-games/workspaces").join(workspace_id);
        let mut meta = read_meta(&workspace_directory).unwrap();
        meta.revision = candidate_revision.clone();
        let tree = candidate_dir(&home, &candidate_id).join("tree");
        write_meta(&tree, &meta).unwrap();
        let pending = candidate_dir(&home, &candidate_id).join("baseline-pending");
        std::fs::rename(&workspace_directory, &pending).unwrap();
        assert!(!workspace_directory.exists());
        let committed = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home).unwrap();
        assert_eq!(committed["data"]["status"], "accepted");
        assert!(workspace_directory.is_dir(), "recovery completed the swap");
        assert_eq!(read_meta(&workspace_directory).unwrap().revision, candidate_revision);
        assert!(!pending.exists(), "recovery cleaned the pending old baseline");
        assert!(candidate_dir(&home, &candidate_id).join("commit.json").is_file());
        std::fs::remove_dir_all(home).ok();
    }

    /// 崩溃窗口 B（换树完成、回据未写）：工作区已是候选内容、pending 还在 →
    /// 下一次 commit 不二次换树，直接记账收尾并清理 pending。
    #[test]
    fn commit_recovers_a_swap_completed_before_the_receipt() {
        let home = std::env::temp_dir().join(format!("code-game-cand-crash-b-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        let written = write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 1;", &base).unwrap();
        let candidate_revision = written["data"]["candidateRevision"].as_str().unwrap().to_string();
        // 忠实模拟真实崩溃顺序：tree 先补写 workspace.json（step 4），随后两个
        // rename 都完成、回据未写。
        let workspace_directory = home.join("code-games/workspaces").join(workspace_id);
        let mut meta = read_meta(&workspace_directory).unwrap();
        meta.revision = candidate_revision.clone();
        write_meta(&candidate_dir(&home, &candidate_id).join("tree"), &meta).unwrap();
        let pending = candidate_dir(&home, &candidate_id).join("baseline-pending");
        std::fs::rename(&workspace_directory, &pending).unwrap();
        std::fs::rename(candidate_dir(&home, &candidate_id).join("tree"), &workspace_directory).unwrap();
        let committed = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home).unwrap();
        assert_eq!(committed["data"]["status"], "accepted");
        assert_eq!(committed["data"]["committedRevision"], candidate_revision);
        assert_eq!(baseline_digest(&home, workspace_id), candidate_revision, "recovery must not re-swap");
        assert!(!pending.exists());
        assert!(candidate_dir(&home, &candidate_id).join("commit.json").is_file());
        // 再重试一次（回据在）→ 同一结果。
        let replay = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home).unwrap();
        assert_eq!(replay, committed);
        std::fs::remove_dir_all(home).ok();
    }

    /// discard 只作用于候选层：基线摘要不变；候选树删除、记录留墓碑；此后
    /// 读/写/提交被结构化拒绝；重复 discard 幂等。
    #[test]
    fn discard_only_touches_the_candidate_layer() {
        let home = std::env::temp_dir().join(format!("code-game-cand-discard-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 1;", &base).unwrap();
        let discarded = candidate_discard(&json!({"candidateId": candidate_id}), &home).unwrap();
        assert_eq!(discarded["data"]["status"], "rejected");
        assert_eq!(baseline_digest(&home, workspace_id), base, "discard must not touch the baseline");
        assert!(!candidate_dir(&home, &candidate_id).join("tree").exists(), "the candidate tree is recycled");
        assert!(candidate_dir(&home, &candidate_id).join("candidate.json").is_file(), "a tombstone stays for diagnostics");
        assert_eq!(
            candidate_file_read(&json!({"workspaceId": workspace_id, "candidateId": candidate_id, "relativePath": "src/index.ts"}), &home)
                .unwrap_err()
                .code,
            "creator_candidate_discarded"
        );
        assert_eq!(
            write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "x", &base).unwrap_err().code,
            "creator_candidate_discarded"
        );
        assert_eq!(
            candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home)
                .unwrap_err()
                .code,
            "creator_candidate_discarded"
        );
        let again = candidate_discard(&json!({"candidateId": candidate_id}), &home).unwrap();
        assert_eq!(again["data"]["status"], "rejected");
        std::fs::remove_dir_all(home).ok();
    }

    /// 身份链 candidateId → digest → buildId → test record：密封
    /// `candidate:<cid>:<digest>` 的 build.json 才能被候选 test 采信；test 记录带
    /// candidateId 且 workspaceRevision 是候选摘要；build/test 推进状态并记录
    /// lastBuildId。
    #[test]
    fn build_and_test_records_carry_the_candidate_identity_chain() {
        let home = std::env::temp_dir().join(format!("code-game-cand-build-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        let written = write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 1;", &base).unwrap();
        let candidate_revision = written["data"]["candidateRevision"].as_str().unwrap().to_string();

        // build() 的候选分支解析：目标树 + 现场摘要。
        let target = build_target(&json!({"workspaceId": workspace_id, "candidateId": candidate_id}), &home, workspace_id)
            .unwrap()
            .expect("candidate target");
        assert_eq!(target.candidate_id, candidate_id);
        assert_eq!(target.revision, candidate_revision);
        // 形状错误的 candidateId 被显式拒绝（静默当缺席是注入面）。
        assert_eq!(
            build_target(&json!({"workspaceId": workspace_id, "candidateId": 7}), &home, workspace_id)
                .unwrap_err()
                .code,
            "invalid_argument"
        );
        mark_status(&home, &candidate_id, "building").unwrap();
        assert_eq!(read_candidate_record(&home, &candidate_id).unwrap().unwrap().status, "building");

        // 假密封构建：sourceRevision = candidate:<cid>:<digest>。
        let build_id = "a".repeat(64);
        let build_dir = home.join("code-games/builds").join(&build_id);
        std::fs::create_dir_all(&build_dir).unwrap();
        for file in ["game.js", "manifest.json"] {
            std::fs::write(build_dir.join(file), b"{}").unwrap();
        }
        std::fs::write(
            build_dir.join("build.json"),
            json!({
                "buildId": build_id,
                "gameId": "community.test",
                "sourceRevision": format!("candidate:{candidate_id}:{candidate_revision}"),
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            build_candidate_revision(&home, &build_id, &candidate_id, "community.test").unwrap(),
            candidate_revision
        );
        // 归属不符（别的候选 / workspace 形态）→ workspace_build_mismatch。
        assert_eq!(
            build_candidate_revision(&home, &build_id, "candidate-ffffffffffffffff", "community.test")
                .unwrap_err()
                .code,
            "workspace_build_mismatch"
        );
        note_build(&home, &candidate_id, &build_id).unwrap();
        assert_eq!(
            read_candidate_record(&home, &candidate_id).unwrap().unwrap().last_build_id.as_deref(),
            Some(build_id.as_str())
        );

        // test() 的候选分支：密封身份通过；测试记录带 candidateId + 候选摘要。
        let test_target = test_target(
            &json!({"workspaceId": workspace_id, "candidateId": candidate_id, "buildId": build_id}),
            &home,
            workspace_id,
            &build_id,
            "community.test",
        )
        .unwrap()
        .expect("candidate test target");
        assert_eq!(test_target.revision, candidate_revision);
        mark_status(&home, &candidate_id, "testing").unwrap();
        let source = json!({"source": "synthetic"});
        let verdict = json!({"executionOk": true, "verdict": "passed"});
        super::super::creator_code_workspace::write_test_record(
            &home,
            &build_id,
            &test_target.revision,
            7,
            600,
            &super::super::creator_code_workspace::CodeTestOutcome { ok: true, source: &source, verdict: &verdict },
            Some(&candidate_id),
        )
        .unwrap();
        let record: Value =
            serde_json::from_slice(&std::fs::read(home.join("state/creator/code-games/tests").join(format!("{build_id}.json"))).unwrap())
                .unwrap();
        assert_eq!(record["workspaceRevision"], candidate_revision);
        assert_eq!(record["candidateId"], candidate_id);
        std::fs::remove_dir_all(home).ok();
    }

    /// submit：无测试 → untested 诚实标记；最新构建的测试通过 → tests-passed；
    /// awaiting-review 冻结候选树（写拒绝、状态不变）；commit 在 awaiting-review
    /// 下照常工作（应用被审阅内容）。
    #[test]
    fn submit_freezes_the_tree_and_marks_the_review_basis_honestly() {
        let home = std::env::temp_dir().join(format!("code-game-cand-submit-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        let written = write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 1;", &base).unwrap();
        let candidate_revision = written["data"]["candidateRevision"].as_str().unwrap().to_string();
        // 未构建/未测试 → untested。
        let submitted = candidate_submit(&json!({"candidateId": candidate_id}), &home).unwrap();
        assert_eq!(submitted["data"]["status"], "awaiting-review");
        assert_eq!(submitted["data"]["reviewBasis"], "untested");
        // awaiting-review 冻结：写拒绝、状态不变（重验证 build/test 可运行但不改状态）。
        assert_eq!(
            write_candidate(&home, workspace_id, &candidate_id, "src/index.ts", "export default 2;", &candidate_revision)
                .unwrap_err()
                .code,
            "creator_candidate_locked_for_review"
        );
        mark_status(&home, &candidate_id, "building").unwrap();
        assert_eq!(read_candidate_record(&home, &candidate_id).unwrap().unwrap().status, "awaiting-review");
        // 最新构建 + verdict=passed 的测试记录 → tests-passed。
        let build_id = "b".repeat(64);
        let build_dir = home.join("code-games/builds").join(&build_id);
        std::fs::create_dir_all(&build_dir).unwrap();
        for file in ["game.js", "manifest.json"] {
            std::fs::write(build_dir.join(file), b"{}").unwrap();
        }
        std::fs::write(
            build_dir.join("build.json"),
            json!({
                "buildId": build_id,
                "gameId": "community.test",
                "sourceRevision": format!("candidate:{candidate_id}:{candidate_revision}"),
            })
            .to_string(),
        )
        .unwrap();
        note_build(&home, &candidate_id, &build_id).unwrap();
        let source = json!({"source": "synthetic"});
        let verdict = json!({"executionOk": true, "verdict": "passed"});
        super::super::creator_code_workspace::write_test_record(
            &home,
            &build_id,
            &candidate_revision,
            7,
            600,
            &super::super::creator_code_workspace::CodeTestOutcome { ok: true, source: &source, verdict: &verdict },
            Some(&candidate_id),
        )
        .unwrap();
        let resubmitted = candidate_submit(&json!({"candidateId": candidate_id}), &home).unwrap();
        assert_eq!(resubmitted["data"]["reviewBasis"], "tests-passed");
        // awaiting-review 下 commit 照常：应用被审阅的精确候选。
        let committed = candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": base}), &home).unwrap();
        assert_eq!(committed["data"]["status"], "accepted");
        assert_eq!(baseline_digest(&home, workspace_id), candidate_revision);
        std::fs::remove_dir_all(home).ok();
    }

    /// status/list 是只读投影：status 带现场摘要与基线漂移；list 新者在前且有界。
    #[test]
    fn status_and_list_are_bounded_read_only_projections() {
        let home = std::env::temp_dir().join(format!("code-game-cand-status-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let base = fixture_workspace(&home, workspace_id);
        let first = create(&home, workspace_id, json!({"operationId": "op-status-1", "title": "First"}))["data"]["candidateId"]
            .as_str()
            .unwrap()
            .to_string();
        let second = create(&home, workspace_id, json!({"operationId": "op-status-2"}))["data"]["candidateId"]
            .as_str()
            .unwrap()
            .to_string();
        let status = candidate_status(&json!({"candidateId": first}), &home).unwrap();
        assert_eq!(status["data"]["status"], "draft");
        assert_eq!(status["data"]["candidateRevision"], base);
        assert_eq!(status["data"]["drift"]["baselineRevision"], base);
        assert_eq!(status["data"]["drift"]["drifted"], false);
        assert_eq!(status["data"]["title"], "First");
        assert_eq!(status["data"]["operationId"], "op-status-1");
        // 基线前进 → drift.drifted = true（只读，不修改任何状态）。
        super::super::creator_code_workspace::file_write(
            &json!({"workspaceId": workspace_id, "relativePath": "src/extra.ts", "content": "export const a = 1;", "expectedRevision": base}),
            &home,
        )
        .unwrap();
        let drifted = candidate_status(&json!({"candidateId": first}), &home).unwrap();
        assert_eq!(drifted["data"]["drift"]["drifted"], true);
        assert_ne!(drifted["data"]["drift"]["baselineRevision"], base);
        let listed = candidate_list(&json!({"workspaceId": workspace_id}), &home).unwrap();
        assert_eq!(listed["data"]["total"], 2);
        let ids: Vec<&str> = listed["data"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["candidateId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec![second.as_str(), first.as_str()], "newest first");
        assert!(candidate_ids(&home).len() == 2);
        std::fs::remove_dir_all(home).ok();
    }

    /// 每 workspace 候选上限：8 个活跃候选占满后拒绝新建；discard 腾位后可再建。
    #[test]
    fn the_candidate_cap_refuses_when_active_candidates_fill_the_workspace() {
        let home = std::env::temp_dir().join(format!("code-game-cand-cap-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        fixture_workspace(&home, workspace_id);
        let mut ids = Vec::new();
        for index in 0..MAX_CANDIDATES_PER_WORKSPACE {
            ids.push(create(&home, workspace_id, json!({"operationId": format!("op-cap-{index}")}))["data"]["candidateId"]
                .as_str()
                .unwrap()
                .to_string());
        }
        let error = try_create(&home, workspace_id, json!({"operationId": "op-cap-over"})).unwrap_err();
        assert_eq!(error.code, "creator_candidate_limit");
        assert_eq!(candidate_ids(&home).len(), MAX_CANDIDATES_PER_WORKSPACE);
        candidate_discard(&json!({"candidateId": ids[0]}), &home).unwrap();
        let created = try_create(&home, workspace_id, json!({"operationId": "op-cap-over"})).unwrap();
        assert_eq!(candidate_ids(&home).len(), MAX_CANDIDATES_PER_WORKSPACE);
        assert!(!ids.contains(&created["data"]["candidateId"].as_str().unwrap().to_string()));
        std::fs::remove_dir_all(home).ok();
    }

    /// 工具面：写工具要 --allow-local-writes；读工具不需要；未知候选 not_found。
    #[test]
    fn candidate_tools_gate_writes_and_report_missing_candidates() {
        let home = std::env::temp_dir().join(format!("code-game-cand-gate-{}-{}", now_ms(), std::process::id()));
        let missing = run("creator_code_candidate_status", &json!({"candidateId": "candidate-0123456789abcdef"}), &home, false).unwrap_err();
        assert_eq!(missing.code, "not_found");
        let denied = run(
            "creator_code_candidate_create",
            &json!({"workspaceId": "gws-0000000000000000"}),
            &home,
            false,
        )
        .unwrap_err();
        assert_eq!(denied.code, "permission_denied");
        for name in ["creator_code_candidate_commit", "creator_code_candidate_discard", "creator_code_candidate_submit"] {
            let denied = run(name, &json!({"candidateId": "candidate-0123456789abcdef"}), &home, false).unwrap_err();
            assert_eq!(denied.code, "permission_denied", "{name}");
        }
        let listed = run("creator_code_candidate_list", &json!({"workspaceId": "gws-0000000000000000"}), &home, false).unwrap();
        assert_eq!(listed["data"]["total"], 0);
        std::fs::remove_dir_all(home).ok();
    }

    /// 可选参数类型错误显式拒绝（M08/审查 P1-2 约定）：静默丢弃会让调用方误以为
    /// CAS/标签仍然生效。
    #[test]
    fn optional_fields_with_wrong_types_are_rejected() {
        let home = std::env::temp_dir().join(format!("code-game-cand-types-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        fixture_workspace(&home, workspace_id);
        assert_eq!(
            candidate_create(&json!({"workspaceId": workspace_id, "expectedBaseRevision": 7}), &home)
                .unwrap_err()
                .code,
            "invalid_argument"
        );
        assert_eq!(
            candidate_create(&json!({"workspaceId": workspace_id, "title": 7}), &home).unwrap_err().code,
            "invalid_argument"
        );
        assert_eq!(
            candidate_create(&json!({"workspaceId": workspace_id, "operationId": 7}), &home)
                .unwrap_err()
                .code,
            "invalid_argument"
        );
        let created = create(&home, workspace_id, json!({}));
        let candidate_id = created["data"]["candidateId"].as_str().unwrap().to_string();
        assert_eq!(
            candidate_commit(&json!({"candidateId": candidate_id, "expectedBaseRevision": 7}), &home)
                .unwrap_err()
                .code,
            "invalid_argument"
        );
        std::fs::remove_dir_all(home).ok();
    }
}
