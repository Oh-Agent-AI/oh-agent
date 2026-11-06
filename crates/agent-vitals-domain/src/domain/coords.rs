//! 事件定位坐标 `(turn, step, call_id)`——时间线↔队列联动与「T31 · s2」显示的依据。
//!
//! **住 `domain/` 是过渡**：`Coords` 本质是 DSH 原始事件的边界顺延状态机
//! （`observe` match `"turn/start"`/`"step/start"`），按 arch 该在
//! `harnesses/dsh/sessions/`。但 `trajectory::coord_map` / `duration` / `skill` 目前
//! 还直接对 raw 事件跑它（layer-2 债），而这几个又要留 `domain/`——把它放
//! 这里让 domain 侧的调用不再横跨去 harness adapter 取类型，adapter 侧
//! （evidence / compaction）经 `harnesses → domain` 正向依赖取。
//! 终态：per-harness `sessions/evidence` 产出的 `CanonicalSession` 时间线自带解好的
//! 坐标，`Coords` + `coord_map` 一起退场（wire/fold 分离，Phase D 之后）。
//!
//! 三个字段在真实日志里的覆盖率**完全不同**（session-e4b0be69 实测）：
//!
//! | 事件 | turn | step | callId |
//! |---|---|---|---|
//! | `tool/call` | 786/786 | 786/786 | 786/786 |
//! | `tool/result` | 796/796 | 796/796 | **0/796** |
//! | `approval/asked` | **0/2** | **0/2** | 2/2 |
//! | `approval/decided` | 0 | 0 | 0（只有 `id` 回指 asked） |
//! | `sandbox/mode` | 0 | 0 | 0 |
//!
//! 所以**事件自带的优先**，缺的从 `turn/start` · `step/start` 顺延。顺延不是猜：
//! 事件流按 `seq` 有序，`turn/start` 是权威边界，落在 `turn/start(N)` 与
//! `turn/end(N)` 之间的事件就在 turn N 内——实测两对 approval 事件都落在 turn 9
//! 内，与顺延结果一致。
//!
//! `turn/end` 之后、下一个 `turn/start` 之前**清空**：落在任何 turn 之外的事件
//! （真实日志里 `seq=1` 的 `sandbox/mode` 就在首个 turn 之前）诚实给 `null`，
//! 不硬安一个刚结束的 turn 上去。同一条纪律：缺列不编列。

use serde_json::{json, Value};

#[derive(Default)]
pub struct Coords {
    turn: Option<i64>,
    step: Option<i64>,
}

impl Coords {
    /// 用边界事件推进状态。必须在 `resolve` 之前对同一事件调用。
    pub fn observe(&mut self, event: &Value) {
        let Some(etype) = event.get("type").and_then(|v| v.as_str()) else {
            return;
        };
        let field = |k: &str| event.pointer(&format!("/data/{k}")).and_then(|v| v.as_i64());
        match etype {
            "turn/start" => {
                self.turn = field("turn");
                self.step = None; // 新 turn 的 step 由 step/start 给出
            }
            "turn/end" => {
                self.turn = None;
                self.step = None;
            }
            "step/start" => {
                if let Some(t) = field("turn") {
                    self.turn = Some(t);
                }
                self.step = field("step");
            }
            "step/end" => self.step = None,
            _ => {}
        }
    }

    /// 求某事件的 `(turn, step, call_id)`：自带优先，否则用顺延值；都没有则 null。
    pub fn resolve(&self, event: &Value) -> (Value, Value, Value) {
        let own = |k: &str| event.pointer(&format!("/data/{k}")).and_then(|v| v.as_i64());
        let to_json = |v: Option<i64>| v.map_or(Value::Null, |n| json!(n));
        let call_id = event
            .pointer("/data/callId")
            .and_then(|v| v.as_str())
            .map_or(Value::Null, |s| json!(s));
        (
            to_json(own("turn").or(self.turn)),
            to_json(own("step").or(self.step)),
            call_id,
        )
    }
}
