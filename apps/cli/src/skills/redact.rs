//! 脱敏：让扫描结果能安全地贴到 issue / 群里。
//!
//! 不变量 11。这块已经漏过**三次**，三次都是同一个失效模式 ——
//! 「没想到还有这个字段」：
//!   1. 名字残留在 `path`（只改了 name 字段）
//!   2. `description` 自由文本清不干净（改为整体丢弃）
//!   3. `removed_skills` 的名字只存在于基线；`namespace` / `plugin_key` /
//!      `enabled_plugins` 里的插件名与 marketplace 名从来不在收集白名单里
//!
//! 所以下面这三份清单**指望不上写全**，兜底是属性测试不是清单。

use std::collections::HashMap;

use regex::Regex;
use serde_json::{Map, Value};

/// 承载 skill 名的键。列表元素继承父键 —— `removed_skills` 里是一串裸名字符串。
const SKILL_NAME_KEYS: [&str; 5] = ["name", "dir_name", "skill", "added_skills", "removed_skills"];
/// 承载插件名的键。
const PLUGIN_NAME_KEYS: [&str; 1] = ["namespace"];
/// 承载 `<plugin>@<marketplace>` 复合形态的键。marketplace 常常就是公司名。
const PLUGIN_KEY_KEYS: [&str; 2] = ["plugin_key", "enabled_plugins"];
/// 执行环境实例名。`instance_id = Path(instance_root).name` —— 用户机器上的
/// 目录名，常常就是工作区或客户项目的名字，与 skill 名同一性质。
/// 收集它之后，instance_root / config_path / conflict_domain 里嵌着的同一串
/// 会被单遍替换一起清掉，不必逐个字段列举。
const INSTANCE_NAME_KEYS: [&str; 1] = ["instance_id"];

pub struct NameMap {
    order: Vec<String>,
    map: HashMap<String, String>,
}

impl NameMap {
    fn new() -> Self {
        NameMap {
            order: Vec::new(),
            map: HashMap::new(),
        }
    }

    fn alias(&self, prefix: &str) -> String {
        let n = self.map.values().filter(|v| v.starts_with(prefix)).count() + 1;
        format!("{}-{:03}", prefix, n)
    }

    fn put(&mut self, real: &str, prefix: &str) {
        if real.is_empty() || self.map.contains_key(real) {
            return;
        }
        let a = self.alias(prefix);
        self.order.push(real.to_string());
        self.map.insert(real.to_string(), a);
    }

    /// 长名优先，避免短名先命中造成部分替换。稳定排序：等长时保持收集顺序。
    fn ordered(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .order
            .iter()
            .map(|k| (k.clone(), self.map[k].clone()))
            .collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.0.chars().count()));
        v
    }
}

fn collect(o: &Value, key: Option<&str>, nm: &mut NameMap) {
    match o {
        Value::Object(map) => {
            for (k, v) in map {
                collect(v, Some(k), nm);
            }
        }
        Value::Array(a) => {
            // 列表元素继承父键
            for v in a {
                collect(v, key, nm);
            }
        }
        Value::String(s) => {
            let k = match key {
                Some(k) => k,
                None => return,
            };
            if s.is_empty() {
                return;
            }
            if SKILL_NAME_KEYS.contains(&k) {
                nm.put(s, "skill");
            } else if PLUGIN_NAME_KEYS.contains(&k) {
                nm.put(s, "plugin");
            } else if INSTANCE_NAME_KEYS.contains(&k) {
                nm.put(s, "instance");
            } else if PLUGIN_KEY_KEYS.contains(&k) {
                if let Some((plug, mkt)) = s.split_once('@') {
                    nm.put(plug, "plugin");
                    nm.put(mkt, "market");
                }
            }
        }
        _ => {}
    }
}

/// 把路径里等于用户名的**整段**替换掉。
///
/// 移植清单第 1 条：Python 用的是 `(?<=[/\\])user(?=[/\\]|$)`，而 `regex`
/// crate **不支持** lookbehind / lookaround。改写成捕获组 `([/\\])user([/\\]|$)`
/// 也不行 —— 那会消费掉尾部分隔符，`/alice/alice/` 的第二段就匹配不上了。
/// 所以这里干脆不用正则：按分隔符切段，逐段比较。语义等价且更好读。
///
/// 注意首段不替换（Python 的 lookbehind 要求**前面**必须有分隔符），
/// 结尾算边界（`(?=[/\\]|$)` 的 `$`）。
fn replace_user_segments(s: &str, user_lower: &str) -> String {
    if user_lower.is_empty() {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut seg = String::new();
    let mut has_preceding_sep = false;

    let flush = |seg: &str, has_sep: bool, out: &mut String| {
        if has_sep && seg.to_lowercase() == user_lower {
            out.push_str("<user>");
        } else {
            out.push_str(seg);
        }
    };

    for ch in s.chars() {
        if ch == '/' || ch == '\\' {
            flush(&seg, has_preceding_sep, &mut out);
            out.push(ch);
            seg.clear();
            has_preceding_sep = true;
            continue;
        }
        seg.push(ch);
    }
    flush(&seg, has_preceding_sep, &mut out);
    out
}

struct Fixer {
    home_n: String,
    cwd_n: String,
    user_lower: String,
    name_re: Option<Regex>,
    alias_of: HashMap<String, String>,
    names: bool,
}

impl Fixer {
    fn fix_str(&self, s: &str) -> String {
        let mut out = s.to_string();
        for (src, dst) in [(&self.home_n, "~"), (&self.cwd_n, ".")] {
            if src.is_empty() {
                continue;
            }
            out = out.replace(src.as_str(), dst);
            out = out.replace(&src.replace('/', "\\"), dst);
        }
        replace_user_segments(&out, &self.user_lower)
    }

    fn walk(&self, o: &Value, key: Option<&str>) -> Value {
        match o {
            Value::Object(map) => {
                let mut m = Map::new();
                for (k, v) in map {
                    m.insert(k.clone(), self.walk(v, Some(k)));
                }
                Value::Object(m)
            }
            Value::Array(a) => Value::Array(a.iter().map(|v| self.walk(v, key)).collect()),
            Value::String(s) => {
                // description 是自由文本，可能含真名、雇主、客户名、项目代号。
                // 这类内容无法靠模式匹配清除，只能整体丢弃。
                // 预算数字在脱敏前就算好了，丢正文不影响任何统计。
                if self.names && key == Some("description") {
                    return Value::String(format!("<redacted: {} chars>", s.chars().count()));
                }
                let fixed = self.fix_str(s);
                match &self.name_re {
                    Some(re) => Value::String(
                        re.replace_all(&fixed, |c: &regex::Captures| {
                            self.alias_of
                                .get(&c[0])
                                .cloned()
                                .unwrap_or_else(|| c[0].to_string())
                        })
                        .into_owned(),
                    ),
                    None => Value::String(fixed),
                }
            }
            other => other.clone(),
        }
    }
}

/// 脱敏入口。`names=false` 时只处理路径，不动名字。
pub fn redact(obj: &Value, names: bool, home_n: &str, cwd_n: &str) -> Value {
    let user = home_n
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();

    let (name_re, alias_of) = if names {
        let mut nm = NameMap::new();
        collect(obj, None, &mut nm);
        let ordered = nm.ordered();
        if ordered.is_empty() {
            (None, HashMap::new())
        } else {
            // 一次扫过、不回头：交替正则一遍替换完，替换产生的别名不会再被
            // 后续规则命中。顺序替换（逐个 str::replace）在真名是别名的子串时
            // 会把已脱敏的部分再改一次 —— 比如 skill 名叫 "in"、别名 "plugin-001"。
            // regex crate 的交替是 leftmost-first，与 Python 的 re 一致，
            // 所以长名在前就能得到相同的匹配优先级。
            let pat = ordered
                .iter()
                .map(|(r, _)| regex::escape(r))
                .collect::<Vec<_>>()
                .join("|");
            let map: HashMap<String, String> = ordered.into_iter().collect();
            (Regex::new(&pat).ok(), map)
        }
    } else {
        (None, HashMap::new())
    };

    let fixer = Fixer {
        home_n: home_n.to_string(),
        cwd_n: cwd_n.to_string(),
        user_lower: user.to_lowercase(),
        name_re,
        alias_of,
        names,
    };
    fixer.walk(obj, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::json;

    const HOME: &str = "/home/alice";
    const CWD: &str = "/work/proj";

    fn r(v: Value, names: bool) -> Value {
        redact(&v, names, HOME, CWD)
    }

    // 期望值来自 tests/test_characterization.py::TestRedactPureBehaviour

    #[test]
    fn home_and_cwd_replaced() {
        assert_eq!(
            r(json!({"path": "/home/alice/.claude/skills/x"}), false)["path"],
            json!("~/.claude/skills/x")
        );
        assert_eq!(r(json!({"p": "/work/proj/a"}), false)["p"], json!("./a"));
    }

    #[test]
    fn username_only_replaced_as_whole_segment() {
        let out = r(
            json!({"a": "/data/alice/x", "b": "/data/alicexyz/x",
                   "c": "/data/xyzalice/x", "d": "/data/alice"}),
            false,
        );
        assert_eq!(out["a"], json!("/data/<user>/x"));
        assert_eq!(out["b"], json!("/data/alicexyz/x"), "前缀匹配不得替换");
        assert_eq!(out["c"], json!("/data/xyzalice/x"), "后缀匹配不得替换");
        assert_eq!(out["d"], json!("/data/<user>"), "行尾的路径段要替换");
    }

    #[test]
    fn consecutive_segments_both_replaced() {
        // 捕获组写法会漏掉第二段（尾部分隔符被吃掉），这条钉住它
        assert_eq!(
            r(json!({"p": "/x/alice/alice/y"}), false)["p"],
            json!("/x/<user>/<user>/y")
        );
    }

    #[test]
    fn username_match_is_case_insensitive() {
        assert_eq!(r(json!({"p": "/data/ALICE/x"}), false)["p"], json!("/data/<user>"[..12].to_owned() + "/x"));
    }

    #[test]
    fn backslash_separators_handled() {
        assert_eq!(
            r(json!({"p": r"\data\alice\x"}), false)["p"],
            json!(r"\data\<user>\x")
        );
    }

    #[test]
    fn description_dropped_wholesale() {
        assert_eq!(
            r(json!({"description": "any free text"}), true)["description"],
            json!("<redacted: 13 chars>")
        );
        assert_eq!(
            r(json!({"description": "any free text"}), false)["description"],
            json!("any free text")
        );
    }

    #[test]
    fn plugin_and_marketplace_names_redacted() {
        let out = r(
            json!({"skills": [{
                "name": "s", "dir_name": "s",
                "namespace": "acme-internal",
                "plugin_key": "acme-internal@corp-market",
                "usage_key_matched": "acme-internal:s",
                "path": "/h/.claude/plugins/cache/corp-market/acme-internal/skills/s"}]}),
            true,
        );
        let raw = serde_json::to_string(&out).unwrap();
        assert!(!raw.contains("acme-internal"), "插件名泄露：{}", raw);
        assert!(!raw.contains("corp-market"), "marketplace 名泄露：{}", raw);
    }

    #[test]
    fn removed_skills_from_baseline_redacted() {
        let out = r(
            json!({"skills": [{"name": "kept", "dir_name": "kept"}],
                   "diff_vs_baseline": {"removed_skills": ["secret-client-tool"]}}),
            true,
        );
        let raw = serde_json::to_string(&out).unwrap();
        assert!(!raw.contains("secret-client-tool"));
    }

    #[test]
    fn alias_not_rewritten_by_a_later_rule() {
        let out = r(
            json!({"skills": [{"name": "in", "dir_name": "in"},
                              {"name": "other", "dir_name": "other"}],
                   "note": "in and other"}),
            true,
        );
        for s in out["skills"].as_array().unwrap() {
            let n = s["name"].as_str().unwrap();
            assert!(
                n.starts_with("skill-") && n.len() == 9,
                "别名被后续规则改坏了：{}",
                n
            );
        }
    }

    // ── 属性测试（ENGINEERING §4.4 第 3 层）──────────────
    //
    // §4.4 单列这条的理由：脱敏漏过**三次**，每次都是「没想到还有这个
    // 字段」—— 名字残留在 path、description 清不干净、removed_skills 与
    // namespace 从来不在白名单里。**用例只能测你想到的字段。**
    //
    // 与 Python 侧 tests/test_properties.py 是同一组性质，两边都跑。

    /// `redact` 自己产出的人工串。断言前必须抹掉，否则一个叫 "kill" 的
    /// skill 会因为输出里有 "skill-001" 被误判 —— 那个子串来自别名模板，
    /// 不携带任何原始信息。
    fn scrub_artifacts(s: &str) -> String {
        let re = Regex::new(r"(?:skill|plugin|market|instance)-\d{3,}|<redacted: \d+ chars>|<user>")
            .unwrap();
        re.replace_all(s, "\u{0}").into_owned()
    }

    /// 只取字符串**值**：整数字面量与键名不该参与断言。
    fn string_values(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => m.values().for_each(|x| string_values(x, out)),
            Value::Array(a) => a.iter().for_each(|x| string_values(x, out)),
            Value::String(s) => out.push(s.clone()),
            _ => {}
        }
    }

    /// 把名字种进每一个已知承载位置，含三处容易被漏掉的：
    /// path、只存在于基线的 removed_skills、`<plugin>@<market>` 复合形态。
    fn doc(skills: &[String], plugins: &[String], markets: &[String], removed: &[String],
           instances: &[String]) -> Value {
        let recs: Vec<Value> = skills.iter().enumerate().map(|(i, n)| {
            let p = &plugins[i % plugins.len()];
            let m = &markets[i % markets.len()];
            json!({
                "name": n, "dir_name": n, "namespace": p,
                "plugin_key": format!("{}@{}", p, m),
                "usage_key_matched": format!("{}:{}", p, n),
                // **独立于 markets 的一组名字。**曾经这里复用 m，于是
                // instance_id 即便不在白名单里，也会被 plugin_key 那条
                // 顺带清掉 —— 测试看起来在测它，其实没有。
                "instance_id": instances[i % instances.len()],
                "config_path": format!("/home/u/.openclaw/{}/config.json",
                                       instances[i % instances.len()]),
                "conflict_domain": format!("openclaw:{}", instances[i % instances.len()]),
                "path": format!("/home/u/.claude/plugins/cache/{}/{}/skills/{}", m, p, n),
                "description": format!("free text mentioning {} and {}", n, p),
            })
        }).collect();
        json!({
            "skills": recs,
            "plugin_state": {"enabled_plugins": plugins.iter()
                .flat_map(|p| markets.iter().map(move |m| format!("{}@{}", p, m)))
                .collect::<Vec<_>>()},
            "conflicts": skills.iter().map(|n| json!({"name": n})).collect::<Vec<_>>(),
            "diff_vs_baseline": {"removed_skills": removed, "added_skills": skills},
        })
    }

    /// 生成的名字统一带 `zz` 前缀。
    ///
    /// **不是洁癖，是为了让断言有意义。**语料里的结构字面量
    /// （`config.json`、`.openclaw`、`/home/u/...`）本身含字母，一个生成成
    /// `"c"` 的名字会在 `config.json` 里被"找到"，报出并不存在的泄露；
    /// 一个生成成 `"a"` 的名字会把 `.openclaw` 改成 `.openclplugin-001w`。
    /// 前缀取任何结构字面量里都没有的 `zz`，断言才精确。
    ///
    /// 这不削弱性质：属性测试要覆盖的是**结构**维度（名字可能出现在哪些
    /// 字段、哪些嵌套层级），不是字符集维度。
    fn names() -> impl Strategy<Value = Vec<String>> {
        proptest::collection::vec("zz[A-Za-z0-9_-]{1,10}", 1..5)
    }

    proptest! {
        /// 属性 1：任意名字集合下，输出里不得出现任何真名 ——
        /// **任何字段、任何嵌套层级。**
        #[test]
        fn no_real_name_survives_anywhere(
            sk in names(), pl in names(), mk in names(), rm in names(), inst in names()
        ) {
            // 名字集合之间不得交叉，否则「谁映射成什么」本身是歧义的
            let mut all: Vec<&String> = sk.iter().chain(&pl).chain(&mk).chain(&rm)
                .chain(&inst).collect();
            let before = all.len();
            all.sort();
            all.dedup();
            prop_assume!(all.len() == before);

            let out = redact(&doc(&sk, &pl, &mk, &rm, &inst), true, HOME, CWD);
            let mut values = Vec::new();
            string_values(&out, &mut values);
            for v in &values {
                let scrubbed = scrub_artifacts(v);
                for n in sk.iter().chain(&pl).chain(&mk).chain(&rm).chain(&inst) {
                    prop_assert!(!scrubbed.contains(n.as_str()),
                        "真名 {:?} 残留在 {:?}", n, v);
                }
            }
        }

        /// 同一个名字在所有字段里必须换成同一个别名，否则读者无法把行对上。
        #[test]
        fn one_name_maps_to_one_alias(sk in names()) {
            let out = redact(&doc(&sk, &["p".into()], &["m".into()], &[], &["i".into()]), true, HOME, CWD);
            for s in out["skills"].as_array().unwrap() {
                prop_assert_eq!(&s["name"], &s["dir_name"]);
                let alias = s["name"].as_str().unwrap();
                prop_assert!(s["path"].as_str().unwrap().ends_with(alias));
            }
        }

        /// 脱敏不得改变文档结构 —— 类型与嵌套层级必须逐一对应。
        #[test]
        fn structure_is_preserved(sk in names(), rm in names()) {
            let src = doc(&sk, &["p".into()], &["m".into()], &rm, &["i".into()]);
            let out = redact(&src, true, HOME, CWD);
            fn shape(v: &Value) -> Value {
                match v {
                    Value::Object(m) => Value::Object(
                        m.iter().map(|(k, x)| (k.clone(), shape(x))).collect()),
                    Value::Array(a) => Value::Array(a.iter().map(shape).collect()),
                    Value::String(_) => json!("s"),
                    other => other.clone(),
                }
            }
            prop_assert_eq!(shape(&src), shape(&out));
        }

        /// 不开 names 时**不得**动名字 —— 只处理路径。
        #[test]
        fn paths_only_mode_keeps_names(sk in names()) {
            let out = redact(&doc(&sk, &["p".into()], &["m".into()], &[], &["i".into()]), false, HOME, CWD);
            for (i, s) in out["skills"].as_array().unwrap().iter().enumerate() {
                prop_assert_eq!(s["name"].as_str().unwrap(), sk[i].as_str());
            }
        }
    }

    #[test]
    fn numbers_and_bools_pass_through() {
        let out = r(json!({"n": 5, "b": true, "z": null}), true);
        assert_eq!(out, json!({"n": 5, "b": true, "z": null}));
    }
}
