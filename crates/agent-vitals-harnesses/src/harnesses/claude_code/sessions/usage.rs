//! Claude Code 行级 usage 词表 + 日期/桶读取原语——fold（`claude_cost`）与
//! UsageFact emitter（`claude_code::sources::usage_fact`）共享的唯一 extractor
//! （R1「共享 extractor」，commit d0ec2f2 的延续）。
//!
//! v0.9 Stage A emitter 归位（R4 §5.2 scope gap）把这三个原语从二进制
//! `claude_cost.rs` 搬进 harnesses 纯层：emitter 住进 harnesses 后不能再反向 import
//! 二进制 crate，而 fold 与 emitter **不得各自解释 usage 形状**——唯一的家
//! 就是本模块。纯内存输入（`&Value`/`&str`），wasm 可链，与 codex 侧的
//! `harnesses/codex/sessions/usage.rs` 同位对称。

use agent_vitals_domain::usage::ms_from_civil;
use agent_vitals_domain::util::civil_from_unix_secs;
use serde_json::Value;

/// 行级 usage 的 4 个计数键（API 全形，真机 100%；写入桶的固定键序）。
pub const SNAKE_KEYS: [&str; 4] = [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
];
/// 行级 usage 的短键旧形状（§2.4 勘误后：真机 0 命中，仍认——旧客户端语料）。
/// 顺序与 SNAKE_KEYS 一一对应。
const SHORT_KEYS: [&str; 4] = ["input", "cache_read", "cache_creation", "output"];

/// ISO 时间戳（`YYYY-MM-DDTHH:MM:SS[.fff]Z`）→ **北京日** "YYYY-MM-DD"。
///
/// 为什么从字符串直接算而不经 epoch：真机 100% 定宽 Z 格式（753e080a 尾部
/// 5847 个样本全同形），日线只需日期 + 小时两截——北京 = UTC+8，UTC 时刻
/// 小时 ≥ 16 就跨到次日。经 epoch 转换反而要先解析小数秒（位数不定）再走
/// civil 表，两侧各多几十行还更容易漂。非 Z 后缀 / 非 ASCII / 超界数字 →
/// None（哨兵，绝不猜时区——带 `+05:00` 的旧格式若存在，按 UTC 算会把日线
/// 算错）。
pub fn day_from_iso_ts(ts: &str) -> Option<String> {
    let b = ts.as_bytes();
    if !ts.is_ascii()
        || b.len() < 20
        || b.get(10) != Some(&b'T')
        || b.last() != Some(&b'Z')
    {
        return None;
    }
    let y: i64 = ts[0..4].parse().ok()?;
    let mo: u32 = ts[5..7].parse().ok()?;
    let d: u32 = ts[8..10].parse().ok()?;
    let hh: u32 = ts[11..13].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || hh > 23 {
        return None;
    }
    let (y, mo, d) = if hh >= 16 { add_day(y, mo, d) } else { (y, mo, d) };
    Some(format!("{y:04}-{mo:02}-{d:02}"))
}

/// 同 `day_from_iso_ts` 认的时间戳格式 → epoch 毫秒。给
/// `agent_vitals_domain::usage::is_peak_slot` 用——它要精确的北京小时 + 星期几，
/// `day_from_iso_ts` 只算到"哪一天"不够。复用同一套格式校验，只多读
/// `mm`/`ss` 两截；真实日期校验委托 `usage::ms_from_civil`（Hinnant 算法
/// 往返比对，不在这里重开一套闰年表）。
pub fn ms_from_iso_ts(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if !ts.is_ascii()
        || b.len() < 20
        || b.get(10) != Some(&b'T')
        || b.last() != Some(&b'Z')
    {
        return None;
    }
    let y: i64 = ts[0..4].parse().ok()?;
    let mo: u32 = ts[5..7].parse().ok()?;
    let d: u32 = ts[8..10].parse().ok()?;
    let hh: u32 = ts[11..13].parse().ok()?;
    let mm: u32 = ts[14..16].parse().ok()?;
    let ss: u32 = ts[17..19].parse().ok()?;
    ms_from_civil(y, mo, d, hh, mm, ss)
}

/// 公历日 +1（月末/年末/闰年走同一张表）。真机语料无闰日样本——测试钉
/// 2028-02-29 / 2026-12-31 / 普通月末四条边。
fn add_day(y: i64, mo: u32, d: u32) -> (i64, u32, u32) {
    let dim = match mo {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 31,
    };
    if d < dim {
        (y, mo, d + 1)
    } else if mo == 12 {
        (y + 1, 1, 1)
    } else {
        (y, mo + 1, 1)
    }
}

/// epoch 毫秒 → 北京日。v0.6.x 前置热修（2026-09-03）之前，cost-state 的
/// `startTime` 走这条算 `baseline_day`——那正是被撤销的"把累计整段摊给一天"
/// 的旧算法（见 `claude_cost.rs::apply_record`）。函数本身保留（不是没用了，
/// 是没有生产调用点）：`day_from_iso_ts`/`day_from_ms` 是一对基础日期转换
/// 原语，Python 镜像 `claude_cost.py::day_from_ms` 同样保留且仍有自己的
/// 钉测——两侧的"可移植纯函数"清单要保持同构，不能因为当前唯一调用点
/// 消失就单边删掉一个，那样下次真需要「epoch ms → 北京日」时会两侧各自
/// 重新发明。
pub fn day_from_ms(ms: i64) -> String {
    let (y, mo, d) = civil_from_unix_secs(ms.div_euclid(1000), 8 * 3600);
    format!("{y:04}-{mo:02}-{d:02}")
}

/// 从 usage 对象嗅 4 桶 token。两态都认、全形优先；键在而值不是数 → 该形
/// 状不算命中（corpus 值全 int）。两态皆无 → None → 哨兵计数（P0）。
///
/// fold 与 emitter 复用同一个 token 读取器，不得各自解释 usage 形状。
/// 负值/超 i64 值在 Python `_row_tokens`（任意精度 int、只拒 bool）与 Rust
/// `as_u64` 间有已知的病理输入分歧——corpus 恒非负，两侧真实行为一致，
/// 分歧面留给注释说明不追平。
pub fn row_tokens(usage: &Value) -> Option<[u64; 4]> {
    let obj = usage.as_object()?;
    let mut out = [0u64; 4];
    // 全形优先，短键兜底——两态都认。
    for keys in [&SNAKE_KEYS[..], &SHORT_KEYS[..]] {
        let mut ok = true;
        for (i, k) in keys.iter().enumerate() {
            match obj.get(*k).and_then(Value::as_u64) {
                Some(v) => out[i] = v,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            return Some(out);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn day_from_iso_ts_beijing_dayline() {
        // Python 同组 fixture。小时 ≥ 16（UTC）跨到次日；< 16 同日。
        assert_eq!(day_from_iso_ts("2026-08-30T10:16:26.965Z"), Some("2026-08-30".into()));
        assert_eq!(day_from_iso_ts("2026-08-30T20:16:26.965Z"), Some("2026-08-31".into()));
        assert_eq!(day_from_iso_ts("2026-08-30T16:00:00Z"), Some("2026-08-31".into()));
        assert_eq!(day_from_iso_ts("2026-08-30T15:59:59Z"), Some("2026-08-30".into()));
        // 无小数秒 / 无秒的定宽格式也认（date + hour 两截就够）。
        assert_eq!(day_from_iso_ts("2026-08-30T20:16:00Z"), Some("2026-08-31".into()));
    }

    #[test]
    fn day_from_iso_ts_calendar_edges() {
        // Python 同组 fixture：月尾 / 年末 / 闰日三条边。
        assert_eq!(day_from_iso_ts("2026-08-31T18:00:00Z"), Some("2026-09-01".into()));
        assert_eq!(day_from_iso_ts("2026-12-31T17:00:00Z"), Some("2027-01-01".into()));
        assert_eq!(day_from_iso_ts("2026-12-31T15:00:00Z"), Some("2026-12-31".into()));
        assert_eq!(day_from_iso_ts("2028-02-29T17:00:00Z"), Some("2028-03-01".into())); // 闰年
        assert_eq!(day_from_iso_ts("2026-02-28T17:00:00Z"), Some("2026-03-01".into())); // 平年
        assert_eq!(day_from_iso_ts("2026-02-28T15:00:00Z"), Some("2026-02-28".into()));
    }

    #[test]
    fn day_from_iso_ts_rejects_non_z_and_garbage() {
        // Python 同组 fixture：非 Z 后缀/超界/坏格式 → None（哨兵，不猜时区）。
        assert_eq!(day_from_iso_ts("2026-08-30T10:16:26.965+00:00"), None);
        assert_eq!(day_from_iso_ts("2026-13-01T10:00:00Z"), None);
        assert_eq!(day_from_iso_ts("2026-08-32T10:00:00Z"), None);
        assert_eq!(day_from_iso_ts("2026-08-30T24:00:00Z"), None);
        assert_eq!(day_from_iso_ts("2026-08-30T10:00:00"), None);
        assert_eq!(day_from_iso_ts("not-a-timestamp"), None);
        assert_eq!(day_from_iso_ts(""), None);
    }

    #[test]
    fn day_from_ms_beijing() {
        // Python 同组 fixture（epoch ms 与日期核对，数值用真值：
        // 1788084986000 ms = 2026-08-30T10:16:26Z → 北京 08-30 18:16）。
        assert_eq!(day_from_ms(1_788_084_986_000), "2026-08-30");
        // 1788112800000 ms = 2026-08-30T18:00:00Z → 北京 08-31 02:00。
        assert_eq!(day_from_ms(1_788_112_800_000), "2026-08-31");
        // 1970-01-01T00:00:00Z → 北京 1970-01-01（epoch 原点偏移非负断言）。
        assert_eq!(day_from_ms(0), "1970-01-01");
    }

    #[test]
    fn row_tokens_accepts_both_shapes_and_sentinels() {
        // Python 同组 fixture（P0 两态嗅探）：全形优先、短键兜底、两态皆无 →
        // None → 哨兵。键在而值不是数 → 该形状不算命中。
        let full = json!({"input_tokens": 100, "cache_read_input_tokens": 200,
                          "cache_creation_input_tokens": 300, "output_tokens": 400,
                          "inference_geo": "xx", "iterations": 1});
        assert_eq!(row_tokens(&full), Some([100, 200, 300, 400]));
        // 真机 753e080a 尾部 6 行的 5 键子集：装饰键缺席、计数键齐全。
        let subset = json!({"input_tokens": 5, "cache_read_input_tokens": 6,
                            "cache_creation_input_tokens": 7, "output_tokens": 8,
                            "service_tier": "low"});
        assert_eq!(row_tokens(&subset), Some([5, 6, 7, 8]));
        // 短键旧形状（真机 0 命中，仍认）。
        let short = json!({"input": 10, "cache_read": 20, "cache_creation": 30,
                           "output": 40});
        assert_eq!(row_tokens(&short), Some([10, 20, 30, 40]));
        // 两态皆无 → 哨兵（P0：绝不把认不出的 usage 当 0）。
        assert_eq!(row_tokens(&json!({"prompt_tokens": 1})), None);
        // 键在而值不是数 → 全形不算命中、短键也够不着 → None。
        assert_eq!(row_tokens(&json!({"input_tokens": 1, "cache_read_input_tokens": 2,
                                      "cache_creation_input_tokens": 3,
                                      "output_tokens": "oops"})), None);
        assert_eq!(row_tokens(&json!({})), None);
    }
}
