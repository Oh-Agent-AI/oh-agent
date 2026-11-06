//! `session_ref`：不可反推的会话引用（spec §9.2 / M0 D5）。
//!
//! `session_key`（`SessionKey::ledger_key`）内嵌执行环境原生 session id——绝不能进
//! MCP 响应。`session_ref = HMAC-SHA256(salt, session_key)` 截前 16 字节 → 32 hex，
//! 加 `sr_` 前缀。salt 每安装随机、`0600`、**不进权威库**（库会被 `data-export-*`
//! 导出）。
//!
//! HMAC 手写（`sha2` 已是依赖，不新增 `hmac` crate——spec §9.2 明写）。
//!
//! 反解（`session_detail(session_ref)`）：HMAC 单向，所以对候选会话集逐个算
//! HMAC 找匹配。会话数是本机量级（真机 ~300），289 次 HMAC-SHA256 是微秒级。

use std::io::{Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::envelope::ToolError;

const SALT_FILE: &str = ".mcp-session-salt";
const SALT_LEN: usize = 32;

/// HMAC-SHA256（RFC 2104）。`sha2` 单独没有 HMAC，这是标准 15 行构造。
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::new().chain_update(opad).chain_update(inner).finalize());
    out
}

fn random_salt() -> [u8; SALT_LEN] {
    let mut buf = [0u8; SALT_LEN];
    // `takeover::random_hex` 同款：unix `/dev/urandom`。读不到（非 unix）→ 退化
    // 为时间派生（弱，但 session_ref 只要求「不可反推原生 id」而非密码学随机
    // ——且非 unix 不是生产平台，与 machine_namespace 同款文档化缺口）。
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf;
        }
    }
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = Sha256::digest(ns.to_le_bytes());
    buf.copy_from_slice(&seed);
    buf
}

/// 读 `<data_home>/.mcp-session-salt`；缺则生成（32B、`0600`）。
/// 目录只读、写不进去 → `internal_error`（session 工具不可用，但 data_status /
/// usage_hourly 不受影响——它们不调这里）。
pub fn load_or_create_salt(data_home: &Path) -> Result<[u8; SALT_LEN], ToolError> {
    let path = data_home.join(SALT_FILE);
    if let Ok(mut f) = std::fs::File::open(&path) {
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| ToolError::new("internal_error", format!("read session salt: {e}")))?;
        if buf.len() == SALT_LEN {
            let mut salt = [0u8; SALT_LEN];
            salt.copy_from_slice(&buf);
            return Ok(salt);
        }
        // 长度不对 = 被截断/损坏——重建（旧 session_ref 随之失效，可接受：
        // salt 轮换 = 所有 session_ref 换一批，spec §9.2 语义）。
    }
    let salt = random_salt();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&path)
        .map_err(|e| ToolError::new("internal_error", format!("create session salt ({}): {e}", path.display())))?;
    f.write_all(&salt)
        .map_err(|e| ToolError::new("internal_error", format!("write session salt: {e}")))?;
    Ok(salt)
}

/// `sr_` + `hex(HMAC(salt, session_key)[..16])`（16 字节 = 128 bit，碰撞可忽略）。
pub fn session_ref(salt: &[u8; SALT_LEN], session_key: &str) -> String {
    let mac = hmac_sha256(salt, session_key.as_bytes());
    let mut s = String::with_capacity(3 + 32);
    s.push_str("sr_");
    for b in &mac[..16] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 调用指纹等「可被离线穷举验证」的单向值在 MCP 面上的伪名：`ik_` +
/// `hex(HMAC(salt, "fp:" + value)[..12])`。
///
/// 为什么需要：PARSER_VERSION 6 起 `invocation_fingerprint` 是「工具名 + 规范化参数」
/// 的**无盐** fnv1a64——有网 agent 拿到它，就能离线验证一条猜测的命令（例如
/// `cat ~/.ssh/id_rsa`）是否在本机跑过（验收 finding）。加安装级盐后只剩「同一安装内
/// 相同值得同一伪名」这一分组用途。
pub fn pseudonym(salt: &[u8; SALT_LEN], value: &str) -> String {
    let mac = hmac_sha256(salt, format!("fp:{value}").as_bytes());
    let mut s = String::with_capacity(3 + 24);
    s.push_str("ik_");
    for b in &mac[..12] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 在候选 `session_key` 集里找出 `session_ref(salt, k) == target` 的那个。
/// `None` = 没有匹配（salt 轮换过 / 不是本机的 ref / 会话已 soft-delete）。
pub fn resolve<I: IntoIterator<Item = String>>(
    salt: &[u8; SALT_LEN],
    target: &str,
    candidates: I,
) -> Option<String> {
    candidates
        .into_iter()
        .find(|k| session_ref(salt, k) == target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_matches_rfc4231_test_case_1() {
        // RFC 4231 §4.2: key = 0x0b×20, data = "Hi There"
        let key = [0x0bu8; 20];
        let mac = hmac_sha256(&key, b"Hi There");
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn ref_is_stable_prefixed_and_hides_the_key() {
        let salt = [7u8; SALT_LEN];
        let key = "3:dsh|36:c93545b3-d36f-42d1-9970-ddaf8f38052c|6:ns-abc";
        let r = session_ref(&salt, key);
        assert!(r.starts_with("sr_"));
        assert_eq!(r.len(), 3 + 32);
        assert_eq!(session_ref(&salt, key), r, "确定性");
        assert!(!r.contains("c93545b3"), "原生 id 片段不得泄漏");
        // 不同 salt → 不同 ref。
        assert_ne!(session_ref(&[9u8; SALT_LEN], key), r);
    }

    #[test]
    fn resolve_roundtrips_and_misses_cleanly() {
        let salt = [3u8; SALT_LEN];
        let keys = ["k1", "k2", "k3"].map(String::from);
        let r2 = session_ref(&salt, "k2");
        assert_eq!(resolve(&salt, &r2, keys.clone()), Some("k2".to_string()));
        assert_eq!(resolve(&salt, "sr_deadbeef", keys), None);
        // 换 salt → 原 ref 解不出。
        assert_eq!(resolve(&[4u8; SALT_LEN], &r2, ["k2".to_string()]), None);
    }

    #[test]
    fn salt_is_created_0600_and_persists() {
        let dir = std::env::temp_dir().join(format!("av-salt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = load_or_create_salt(&dir).unwrap();
        let b = load_or_create_salt(&dir).unwrap();
        assert_eq!(a, b, "持久");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(SALT_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
