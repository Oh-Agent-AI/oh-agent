//! 价卡协作面：让 Agent（Claude / Codex 经 MCP）替用户补价卡。
//!
//! 背景（2026-09-17）：总览喊「本月有 57M tokens 按量用量的模型没有价格」，用户点
//! 「查看价格表」落到两张空表单不知道要填什么；胜算云对 gpt-6 / MiniMax-M3 的报价
//! 本机也没有。人补卡要翻价格页、抄六个数；Agent 可以查（它那边有网）、可以填。
//! 本工具只暴露与设置页同一套操作（`price_overrides::{cards,save_card,remove_card,
//! save_route}`）加一张「本月缺卡清单」——**不预置任何未经确认的价格**：价卡是价格
//! 证据，仓库里没有的数不能编；Agent 填进来的也标 `basis=user-set`，展示层照旧写
//! 「按其价卡估算」而不是「官方标价」。
//!
//! 读（`missing_list` / `card_list`）默认可用；写（`card_put` / `card_delete` /
//! `route_put`）需要 `--allow-local-writes`，与 control_plane 同一条门槛。

use std::path::Path;

use serde_json::{json, Value};

use super::{build_envelope, coverage_not_applicable, AuthorityHandle, ToolError, ToolSpec};

const ACTIONS: &[&str] = &["missing_list", "card_list", "card_put", "card_delete", "route_put"];
const MUTATIONS: &[&str] = &["card_put", "card_delete", "route_put"];

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "price_cards",
        description: "Price-card assistant for Agent Vitals. `missing_list` returns this month's models with no price card (which provider to file the card under, tokens, whether the usage is metered or inside a subscription); `card_list` returns user-supplied cards and routes; `card_put` files a card (CNY per million tokens; three required rates: input_uncached/input_cached/output × off_peak/peak — pass the same value twice when the provider has no peak pricing; optional fourth rate `cache_write` for relays that bill cache-write tokens separately from cache-miss input — omit it to keep pricing cache-creation tokens at the catalog's flat rate); `card_delete` removes one; `route_put` declares which provider a model prefix belongs to. Cards are user-supplied price evidence (basis=user-set), never official list prices. Mutations require the explicit --allow-local-writes server flag.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ACTIONS },
                "provider_id": { "type": "string", "description": "Catalog provider id, e.g. shengsuanyun / zhipu-glm / deepseek-official" },
                "model_id": { "type": "string", "description": "Model id exactly as it appears in logs (namespace prefix such as openai/ is tolerated)" },
                "model_prefix": { "type": "string" },
                "mode": { "type": "string", "enum": ["metered", "subscription"] },
                "input_uncached": { "type": "object", "properties": { "off_peak": { "type": "number" }, "peak": { "type": "number" } }, "required": ["off_peak", "peak"], "additionalProperties": false },
                "input_cached": { "type": "object", "properties": { "off_peak": { "type": "number" }, "peak": { "type": "number" } }, "required": ["off_peak", "peak"], "additionalProperties": false },
                "output": { "type": "object", "properties": { "off_peak": { "type": "number" }, "peak": { "type": "number" } }, "required": ["off_peak", "peak"], "additionalProperties": false },
                "cache_write": { "type": "object", "description": "Optional fourth dimension. Some relays (e.g. shengsuanyun) bill every cache-miss input token as a full 'write' rather than the catalog's flat cache-write rate — omit this unless the provider's own bill shows that pattern.", "properties": { "off_peak": { "type": "number" }, "peak": { "type": "number" } }, "required": ["off_peak", "peak"], "additionalProperties": false },
                "source": { "type": ["string", "null"], "description": "Where the price came from (URL or note); recorded in the receipt, not in the card" }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard envelope. missing_list → {month, models:[{harness, provider, model, tokens, covered}]}; card_list → {cards, routes}; mutations → receipt {changed, provider_id, model_id}."
        }),
    }
}

pub fn run(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    let action = args.get("action").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "missing required `action`"))?;
    if !ACTIONS.contains(&action) {
        return Err(ToolError::new("invalid_argument", format!("unsupported price_cards action `{action}`")));
    }
    if MUTATIONS.contains(&action) && !allow_local_writes {
        return Err(ToolError::new(
            "permission_denied",
            "price card mutation requires the explicit `--allow-local-writes` server flag; default MCP remains read-only",
        ));
    }
    let handle = AuthorityHandle::open(data_home)?;
    let data = match action {
        "missing_list" => {
            // 与 CLI `data-status` / 设置页「本月缺价卡的型号」同一份数据（data_status
            // 的 unpriced_models_month）——不再长第二份"什么算无价"的判定。
            let status = super::data_status::collect_report_quick(handle.conn(), true, true);
            json!({
                "action": action,
                "month": status.get("month").cloned().unwrap_or(Value::Null),
                "unpriced_metered_tokens_month": status.get("unpriced_metered_tokens_month").cloned().unwrap_or(Value::Null),
                "unpriced_tokens_month": status.get("unpriced_tokens_month").cloned().unwrap_or(Value::Null),
                "models": status.get("unpriced_models_month").cloned().unwrap_or_else(|| json!([])),
                "how_to_file": "card_put with provider_id = the row's `provider`, model_id = the row's `model`, six CNY-per-million-token rates. Rows with covered=true only affect the nominal reference; covered=false affect metered spend.",
            })
        }
        "card_list" => json!({
            "action": action,
            "cards": crate::price_overrides::cards(data_home),
            "routes": crate::price_overrides::routes(data_home),
        }),
        "card_put" => {
            let provider = required_string(args, "provider_id")?;
            let model = required_string(args, "model_id")?;
            let mut card = json!({
                "input_uncached": args.get("input_uncached").cloned().unwrap_or(Value::Null),
                "input_cached": args.get("input_cached").cloned().unwrap_or(Value::Null),
                "output": args.get("output").cloned().unwrap_or(Value::Null),
            });
            // 第四维可选：不传就不进卡（sanitize_card 把"没有这个键"与"传了半截"分开处理——
            // 前者是三维卡，后者整卡拒绝）。
            if let Some(cache_write) = args.get("cache_write") {
                card["cache_write"] = cache_write.clone();
            }
            crate::price_overrides::save_card(data_home, provider, model, &card)
                .map_err(|error| ToolError::new("invalid_argument", error))?;
            json!({
                "action": action, "changed": true, "provider_id": provider, "model_id": model,
                "basis": "user-set",
                "source": args.get("source").cloned().unwrap_or(Value::Null),
                "note": "card is merged over the built-in table at read time; the next summary read prices this model with it",
            })
        }
        "card_delete" => {
            let provider = required_string(args, "provider_id")?;
            let model = required_string(args, "model_id")?;
            crate::price_overrides::remove_card(data_home, provider, model)
                .map_err(|error| ToolError::new("invalid_argument", error))?;
            json!({ "action": action, "changed": true, "provider_id": provider, "model_id": model })
        }
        "route_put" => {
            let prefix = required_string(args, "model_prefix")?;
            let provider = required_string(args, "provider_id")?;
            let mode = args.get("mode").and_then(Value::as_str).unwrap_or("metered");
            crate::price_overrides::save_route(data_home, prefix, provider, mode)
                .map_err(|error| ToolError::new("invalid_argument", error))?;
            json!({ "action": action, "changed": true, "model_prefix": prefix, "provider_id": provider, "mode": mode })
        }
        _ => unreachable!("action validated above"),
    };
    Ok(build_envelope(
        handle.conn(), handle.authority_state(), None,
        coverage_not_applicable(), Vec::new(), data,
    ))
}

fn required_string<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::new("invalid_argument", format!("missing required `{key}`")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("av-mcp-price-cards-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("state")).unwrap();
        let path = agent_vitals_data::authority::default_authority_path(&dir);
        drop(agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap());
        dir
    }

    #[test]
    fn card_put_requires_writes_and_round_trips_through_card_list() {
        let home = tmp_home("roundtrip");
        let card = json!({ "action": "card_put", "provider_id": "shengsuanyun", "model_id": "gpt-6-astra",
            "input_uncached": { "off_peak": 8.0, "peak": 8.0 }, "input_cached": { "off_peak": 0.8, "peak": 0.8 },
            "output": { "off_peak": 40.0, "peak": 40.0 }, "source": "https://example.test/pricing" });
        let denied = run(&card, &home, false).unwrap_err();
        assert_eq!(denied.code, "permission_denied");
        let ok = run(&card, &home, true).unwrap();
        assert_eq!(ok["data"]["changed"], json!(true));
        assert_eq!(ok["data"]["basis"], json!("user-set"));
        let listed = run(&json!({ "action": "card_list" }), &home, false).unwrap();
        assert_eq!(listed["data"]["cards"]["shengsuanyun"]["gpt-6-astra"]["output"]["peak"], json!(40.0));
        // 半张卡整体拒绝（与设置页同一条 sanitize）。
        let half = json!({ "action": "card_put", "provider_id": "shengsuanyun", "model_id": "x",
            "input_uncached": { "off_peak": 1.0, "peak": 1.0 } });
        assert_eq!(run(&half, &home, true).unwrap_err().code, "invalid_argument");
        let missing = run(&json!({ "action": "missing_list" }), &home, false).unwrap();
        assert!(missing["data"]["models"].is_array());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 2026-09-17 事故的另一半：`sanitize_card` 早就接受可选第四维 `cache_write`
    /// （胜算云把非命中输入都记作写入），但 Agent 经 MCP 补卡时没有字段可传——本工具是
    /// 唯一让 Agent 自己把这类中转卡写进去的入口，schema 没开这个口子，公式再对也用不上。
    /// 钉住：不传 → 三维卡；传 → 与其他三维同一半卡拒绝纪律。
    #[test]
    fn card_put_accepts_optional_cache_write_dimension() {
        let home = tmp_home("cache-write");
        let without = json!({ "action": "card_put", "provider_id": "shengsuanyun", "model_id": "gpt-5.6-sol",
            "input_uncached": { "off_peak": 29.310, "peak": 29.310 }, "input_cached": { "off_peak": 2.343, "peak": 2.343 },
            "output": { "off_peak": 140.885, "peak": 140.885 } });
        run(&without, &home, true).unwrap();
        let listed = run(&json!({ "action": "card_list" }), &home, false).unwrap();
        assert!(listed["data"]["cards"]["shengsuanyun"]["gpt-5.6-sol"].get("cache_write").is_none(),
            "no cache_write in the call → none in the saved card");

        let with = json!({ "action": "card_put", "provider_id": "shengsuanyun", "model_id": "gpt-5.6-sol",
            "input_uncached": { "off_peak": 29.310, "peak": 29.310 }, "input_cached": { "off_peak": 2.343, "peak": 2.343 },
            "output": { "off_peak": 140.885, "peak": 140.885 }, "cache_write": { "off_peak": 29.310, "peak": 29.310 } });
        run(&with, &home, true).unwrap();
        let listed = run(&json!({ "action": "card_list" }), &home, false).unwrap();
        assert_eq!(listed["data"]["cards"]["shengsuanyun"]["gpt-5.6-sol"]["cache_write"],
            json!({ "off_peak": 29.310, "peak": 29.310 }));

        let broken = json!({ "action": "card_put", "provider_id": "shengsuanyun", "model_id": "gpt-5.6-broken",
            "input_uncached": { "off_peak": 1.0, "peak": 1.0 }, "input_cached": { "off_peak": 1.0, "peak": 1.0 },
            "output": { "off_peak": 1.0, "peak": 1.0 }, "cache_write": { "off_peak": 1.0 } });
        assert_eq!(run(&broken, &home, true).unwrap_err().code, "invalid_argument",
            "a half cache_write must reject the whole card, same as the three required dimensions");
        let _ = std::fs::remove_dir_all(&home);
    }
}
