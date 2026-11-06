//! DSH 会话「原始事件 → findings」的兼容 shim。
//!
//! `wasm audit_events` 与差分测试传的是一份 **DSH 原始事件流**（`"tool/call"`/
//! `"turn/start"`/`"assistant/chunk"` 形状），这里把它 `post_fork` → 建
//! `CanonicalSession`（`build_dsh_evidence` 填时间线）→ 交给 domain 的 canonical
//! 检测器 → flatten。**规则本体（`match_{behavior,trajectory}_canonical`）住
//! `domain/`，这里只做「DSH wire → canonical」这一段翻译**——phase B 起就是这条
//! 分工，phase C 把它从 `domain/behavior.rs`/`trajectory.rs` 挪进 DSH adapter
//! （domain 不再碰 DSH 的 JSON 事件形状）。
//!
//! 纯函数、确定性：同一事件流重放结果逐字节一致。非 object 的条目跳过；
//! 缺 seq/time 时以 null 落位，绝不伪造 0 次。

use serde_json::Value;

use super::evidence::build_dsh_evidence;
use agent_vitals_domain::behavior::{flatten, match_behavior_canonical};
use agent_vitals_domain::trajectory::{flatten_trajectory, match_trajectory_canonical};
use agent_vitals_domain::util::post_fork;

/// 事件序列 → 行为 findings（SV601–614），按码序产出。产出与旧
/// `match_behavior` 逐字节一致（SV610 分叉除外，见 `match_behavior_canonical`）。
pub fn match_behavior(events: &[Value], workspace_root: Option<&str>) -> Vec<Value> {
    // 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    // branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    // 对同一笔钱/同一批行为重复计数（见 util::fork_boundary 的实测数据）。
    let events = &post_fork(events)[..];
    let evidence = build_dsh_evidence(
        events.to_vec(),
        Vec::new(),
        workspace_root.map(str::to_owned),
        String::new(),
    );
    flatten(&match_behavior_canonical(&evidence.canonical))
}

/// 事件序列 → 轨迹 findings（SV611–614），按码序产出。产出与旧
/// `match_trajectory` 逐字节一致（分叉会话的「上游轨迹不计入本会话」除外，见
/// `match_trajectory_canonical`）。
pub fn match_trajectory(events: &[Value]) -> Vec<Value> {
    let events = &post_fork(events)[..];
    let evidence = build_dsh_evidence(events.to_vec(), Vec::new(), None, String::new());
    flatten_trajectory(&match_trajectory_canonical(&evidence.canonical))
}
