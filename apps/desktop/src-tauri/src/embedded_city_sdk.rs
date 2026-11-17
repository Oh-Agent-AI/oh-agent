//! 嵌入式 city-sdk 语义闸（E5 全量，spec §8.4 路径 2 / §11.6）。
//!
//! 语义权威是 city-sdk 的版本化产物，不是 Studio 这个 app——本模块只是给同一份
//! 校验逻辑换了运行载体：`embedded_city_sdk/city-sdk-gate.iife.js` 由 Studio
//! 适配器同一条 import 链（embeddedGate → sdkValidation / cityWorldOperations →
//! city-sdk）打包而来（构建与锁文件见 embedded_city_sdk/build.mjs），在宿主进程内
//! 的 QuickJS 里执行。桥协议：JSON 字符串进、JSON 字符串出，对象永不跨桥。
//!
//! ## 载体选型：rquickjs（候选 A）而非 wasmtime+Javy（候选 B）
//!
//! - **引擎一致性**：rquickjs 绑定 Bellard QuickJS——与 spike 路径 1
//!   （quickjs-emscripten）同引擎家族；spike 已证明该家族对全部验收向量产出与
//!   V8 逐字节一致的诊断。wasmtime+Javy 多一层动态模块/插件版本钉扎（spike §5
//!   风险 5：文档与实际命名空间不一致），确定性链更长。
//! - **依赖体积**：rquickjs 经 libquickjs-sys 编译 QuickJS C 源（产物约 +1 MB），
//!   引入约 5 个 crate；wasmtime 是 10+ MB 级运行时、上百个 crate 与分钟级编译。
//! - **JSON 桥**：rquickjs 直接 eval + 字符串值交换；Javy 需 stdin/stdout WASM ABI
//!   与外部 CLI 产物管线（产物需入库存放、外部工具链重建）。
//! - **可维护性**：bundle 由仓库内 node 脚本生成并钉进 lockfile，无外部二进制。
//!
//! ## 生命周期封装（spike 风险 ③：handle 泄漏触发断言 abort）
//!
//! 每次 `invoke` 创建一个全新 Runtime/Context，调用结束整体销毁——没有跨调用句柄、
//! 没有长驻堆，泄漏不可能累积。每次调用约 20–40 ms（解释器冷启动一次付清），语义
//! 闸只挂在 preview/define 等写路径上，不构成瓶颈。
//!
//! ## QuickJS 环境补齐（spike 风险 ②）
//!
//! bootstrap 注入 TextEncoder（纯 JS UTF-8）与 `crypto.subtle.digest`（宿主 sha2
//! 桥接，同步返回——SDK 调用点的 `await` 对已解析值原样透传）。四类入口本身不触及
//! digest 路径，注入是为未来内容包/摘要校验器接入预备的等价物。

use rquickjs::{Context, Runtime, function::Func};
use serde_json::Value;
use sha2::{Digest, Sha256};

const GATE_BUNDLE: &str = include_str!("../embedded_city_sdk/city-sdk-gate.iife.js");
pub(crate) const GATE_LOCK_JSON: &str = include_str!("../embedded_city_sdk/bundle.lock.json");

/// 语义闸执行失败的稳定码：调用方按「语义不可用」处理，不得当作校验通过。
pub(crate) const GATE_UNAVAILABLE: &str = "embedded_gate_unavailable";

/// QuickJS 环境补齐（UTF-8 TextEncoder + 同步 sha256 桥）。hex 交换避免引入任何
/// 不确定的 rquickjs 值 API；字节量级（≤几百 KiB）下编码开销可忽略。
const BOOTSTRAP: &str = r#"
function bytesToHex(bytes) { let out = ""; for (const byte of bytes) out += byte.toString(16).padStart(2, "0"); return out; }
function hexToBytes(hex) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
class TextEncoderShim {
  encode(input) {
    const out = [];
    for (const ch of String(input ?? "")) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }
}
globalThis.TextEncoder = TextEncoderShim;
// 嵌入式闸内 digest 是同步的：SDK 调用点的 `await` 对已解析值原样透传。
globalThis.crypto = { subtle: { digest: (_algorithm, bytes) => hexToBytes(host_sha256_hex(bytesToHex(bytes))) } };
"#;

pub(crate) fn gate_lock() -> Value {
    serde_json::from_str(GATE_LOCK_JSON).expect("embedded gate lockfile must parse")
}

pub(crate) fn gate_bundle_digest() -> String {
    format!("sha256:{}", hex_sha256(GATE_BUNDLE.as_bytes()))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 在一次性 QuickJS 运行时里执行一个 gate 入口，返回 invoke 的原始 JSON 字符串。
fn run_gate(entry: &str, args_json: &str) -> Result<String, &'static str> {
    let runtime = Runtime::new().map_err(|_| GATE_UNAVAILABLE)?;
    runtime.set_memory_limit(64 * 1024 * 1024);
    runtime.set_max_stack_size(1024 * 1024);
    let context = Context::full(&runtime).map_err(|_| GATE_UNAVAILABLE)?;
    context.with(|ctx| {
        let sha_bridge = Func::from(|payload_hex: String| -> String {
            let payload = (0..payload_hex.len() / 2)
                .map(|index| u8::from_str_radix(&payload_hex[index * 2..index * 2 + 2], 16))
                .collect::<Result<Vec<u8>, _>>()
                .unwrap_or_default();
            hex_sha256(&payload)
        });
        ctx.globals().set("host_sha256_hex", sha_bridge).map_err(|_| GATE_UNAVAILABLE)?;
        ctx.eval::<(), _>(BOOTSTRAP).map_err(|_| GATE_UNAVAILABLE)?;
        ctx.eval::<(), _>(GATE_BUNDLE).map_err(|_| GATE_UNAVAILABLE)?;
        ctx.globals().set("__gate_entry", entry).map_err(|_| GATE_UNAVAILABLE)?;
        ctx.globals().set("__gate_args", args_json).map_err(|_| GATE_UNAVAILABLE)?;
        ctx.eval::<String, _>("citySdkGate.invoke(globalThis.__gate_entry, globalThis.__gate_args)")
            .map_err(|_| GATE_UNAVAILABLE)
    })
}

/// 执行一个 gate 入口并解析回 JSON。任何执行/解析失败都归一到 GATE_UNAVAILABLE
/// ——语义闸不可用时调用方必须按「无法校验」拒绝，而不是当作通过。
pub(crate) fn invoke(entry: &str, args: &Value) -> Result<Value, &'static str> {
    let args_json = serde_json::to_string(args).map_err(|_| GATE_UNAVAILABLE)?;
    let output = run_gate(entry, &args_json)?;
    serde_json::from_str(&output).map_err(|_| GATE_UNAVAILABLE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LOCKSTEP_JSON: &str = include_str!("../embedded_city_sdk/lockstep-vectors.json");
    const LOCKSTEP_LOCK_JSON: &str = include_str!("../embedded_city_sdk/lockstep-vectors.lock.json");

    #[test]
    fn embedded_bundle_matches_its_lockfile() {
        let lock = gate_lock();
        assert_eq!(lock["schemaVersion"], 1);
        assert_eq!(lock["gateVersion"], 1);
        assert_eq!(lock["bundle"], "city-sdk-gate.iife.js");
        assert_eq!(lock["engine"], "rquickjs (Bellard QuickJS, embedded in agent-vitals-menubar)");
        let recorded = lock["bundleSha256"].as_str().expect("bundleSha256");
        assert_eq!(recorded, hex_sha256(GATE_BUNDLE.as_bytes()), "regenerate with embedded_city_sdk/build.mjs");
        assert!(GATE_BUNDLE.contains("citySdkGate"), "bundle must register the gate global");
        assert!(!GATE_BUNDLE.contains("\\-"), "dist must not carry the QuickJS-incompatible `\\-` class escape");
    }

    #[test]
    fn lockstep_fixture_matches_its_lockfile() {
        let lock: Value = serde_json::from_str(LOCKSTEP_LOCK_JSON).unwrap();
        assert_eq!(lock["schemaVersion"], 1);
        assert_eq!(lock["file"], "lockstep-vectors.json");
        assert_eq!(lock["sha256"], hex_sha256(LOCKSTEP_JSON.as_bytes()), "regenerate via the fixture's regenerate command");
    }

    /// 验收核心（spec §8.7 E5）：同一向量集，SDK-TS 原生路径（Node/V8 生成，
    /// expected 字符串）与嵌入式路径（本模块 QuickJS 重放）逐字节一致。
    #[test]
    fn lockstep_vectors_match_the_sdk_ts_path_byte_for_byte() {
        let fixture: Value = serde_json::from_str(LOCKSTEP_JSON).unwrap();
        let vectors = fixture["vectors"].as_array().expect("vectors array");
        assert!(vectors.len() >= 20, "the acceptance vector set must stay broad, got {}", vectors.len());
        for vector in vectors {
            let id = vector["id"].as_str().unwrap_or_default();
            let entry = vector["entry"].as_str().expect("entry");
            let expected = vector["expected"].as_str().expect("expected string");
            // args_json 与生成器同规格：serde_json preserve_order 保持 fixture 键序，
            // 重序列化即生成器当时的 JSON.stringify 输入。
            let args_json = serde_json::to_string(&vector["args"]).expect("args serialization");
            let actual = run_gate(entry, &args_json).unwrap_or_else(|error| panic!("gate failed for {id}: {error}"));
            assert_eq!(actual, expected, "lockstep divergence on vector {id}");
        }
    }

    /// S1 前置修复的引擎面证明：LABEL 改写后的正则必须在 QuickJS 里可编译（spike
    /// 里 `\-` 写法在此处直接 SyntaxError）。经 bundle 全量加载隐式覆盖之外，这里
    /// 再单独 eval 一次正则本体，把失败钉在最小的复现面上。
    #[test]
    fn quickjs_compiles_the_rewritten_label_regex() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let verdict = context.with(|ctx| {
            ctx.eval::<String, _>(r#"
                const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .·、（）()-]{0,126}$/u;
                JSON.stringify([LABEL.test("扑翼-原型机(wing)-01"), LABEL.test("-x"), LABEL.test("}<script>")])
            "#)
        }).unwrap();
        assert_eq!(verdict, "[true,false,false]");
    }

    /// 环境补齐证明：注入的 TextEncoder/crypto.subtle 在闸内可用（同步 digest）。
    #[test]
    fn bootstrap_env_is_available_inside_the_gate() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| {
            ctx.globals().set("host_sha256_hex", Func::from(|payload_hex: String| -> String {
                let payload = (0..payload_hex.len() / 2)
                    .map(|index| u8::from_str_radix(&payload_hex[index * 2..index * 2 + 2], 16))
                    .collect::<Result<Vec<u8>, _>>().unwrap_or_default();
                hex_sha256(&payload)
            })).unwrap();
            ctx.eval::<(), _>(BOOTSTRAP).unwrap();
            let encoded: u64 = ctx.eval(r#"new TextEncoder().encode("aé").length"#).unwrap();
            assert_eq!(encoded, 3);
            ctx.eval::<(), _>(r#"(async () => {
                const view = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc")));
                let hex = ""; for (const byte of view) hex += byte.toString(16).padStart(2, "0");
                globalThis.__digest_hex = hex;
            })()"#).unwrap();
        });
        // async 包装器把结果放进 promise job（Runtime 在 with 闭包内被 Context 借用，
        // 泵 job 必须在闭包外）；digest 本身同步，泵完即得。
        while matches!(runtime.execute_pending_job(), Ok(true)) {}
        let digested: String = context.with(|ctx| ctx.globals().get("__digest_hex")).unwrap();
        // sha256("abc") 的标准向量。
        assert_eq!(digested, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

#[test]
fn debug_gate_vehicle_fixture() {
    let raw = serde_json::json!({"schemaVersion": 1, "id": "vehicle-headless-2", "label": "E2E flapper", "modelAssetId": null, "flightModel": "flapping",
        "physics": {"massKg": 300.0, "wingAreaM2": 18.0, "thrustN": 6000.0, "maxSpeedMps": 120.0, "dragCoefficient": 0.1,
            "turnRateRps": 0.9, "climbRateMps": 34.0, "sinkRateMps": 26.0, "flapFrequencyHz": 2.4, "flapAmplitudeRad": 1.1},
        "bounds": {"halfLengthM": 3.6, "halfWidthM": 4.8, "halfHeightM": 1.4}});
    let outcome = crate::embedded_city_sdk::invoke("vehicle.validate", &serde_json::json!({ "raw": raw })).unwrap();
    println!("gate outcome ok={} vehicle_keys={:?}", outcome["ok"], outcome["vehicle"].as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()));
    println!("diagnostics={}", outcome["diagnostics"]);
    let (vehicle, envelope) = crate::creator_projects::embedded_vehicle_validation("project-x", 1, &raw).unwrap();
    println!("normalized={vehicle}");
    println!("envelope ok={} diag={}", envelope["ok"], envelope["diagnostics"]);
}


    /// 能力目录锁步守卫（E5）：描述符如实标注 headless 语义校验可用性——
    /// `semanticGate.embeddedSdk: true` 的前提是嵌入产物真实存在（digest 与锁文件
    /// 一致）且真的能出语义判定。声明与能力不一致时在这里失败，不允许能力发现虚报。
    #[test]
    fn capabilities_descriptor_matches_the_embedded_gate_reality() {
        let claim = crate::creator_projects::creator_descriptor()["semanticGate"].clone();
        assert_eq!(claim["schemaVersion"], 1);
        assert_eq!(claim["studioEnvelope"], true);
        assert_eq!(claim["embeddedSdk"], true);
        let coverage = claim["embeddedSdkCoverage"].as_array().expect("coverage list");
        for face in ["vehicle.preview", "vehicle.define", "city.edit.preview(world.set)", "city.edit.commit", "city.create"] {
            assert!(coverage.iter().any(|item| item.as_str() == Some(face)), "coverage must name {face}");
        }
        assert!(!claim["requiresStudio"].as_array().unwrap_or(&Vec::new()).is_empty(), "viewport tiers must be excluded honestly");
        assert_eq!(gate_lock()["bundleSha256"], gate_bundle_digest().strip_prefix("sha256:").unwrap_or_default());
        // 用内置 preset 做一次真闸验证（不只查 digest：bundle 必须真的可执行）。
        let preset = crate::creator_projects::creator_vehicle_catalog()["presets"][0].clone();
        let verdict = invoke("vehicle.profile.validate", &json!({ "raw": preset })).unwrap();
        assert_eq!(verdict["ok"], true, "{}", verdict);
    }


    #[test]
    fn debug_headless_flow_pieces() {
        let home = std::env::temp_dir().join(format!("gate-debug-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        // A: city.list dispatch
        let listed = crate::creator_projects::dispatch_as(&home, crate::creator_projects::LOCAL_CREATOR_OWNER,
            "host-headless", "creator.city.list", &serde_json::json!({"limit": 20}));
        println!("city.list -> {:?}", listed.err());
        // B: envelope self-check on the e2e-style probe vehicle
        let raw = serde_json::json!({"schemaVersion":1,"id":"vehicle-e2e-flap","label":"E2E flapper","modelAssetId":null,"flightModel":"flapping",
            "physics":{"massKg":300.0,"wingAreaM2":18.0,"thrustN":6000.0,"maxSpeedMps":120.0,"dragCoefficient":0.1,
                "turnRateRps":0.9,"climbRateMps":34.0,"sinkRateMps":26.0,"flapFrequencyHz":2.4,"flapAmplitudeRad":1.1},
            "bounds":{"halfLengthM":3.6,"halfWidthM":4.8,"halfHeightM":1.4}});
        let outcome = invoke("vehicle.validate", &serde_json::json!({"raw": raw})).unwrap();
        println!("gate ok={} vehicle={}", outcome["ok"], outcome["vehicle"]);
        let (vehicle, envelope) = crate::creator_projects::embedded_vehicle_validation("vehicle-preview-probe", 0, &raw).unwrap();
        println!("envelope={}", envelope);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 未知入口与非法参数显式判负（桥协议自身的行为，不依赖具体校验器）。
    #[test]
    fn unknown_entry_and_invalid_args_fail_closed() {
        let unknown = invoke("no.such.entry", &json!({})).unwrap();
        assert_eq!(unknown["ok"], false);
        assert_eq!(unknown["diagnostics"][0]["code"], "embedded_gate_entry_unknown");
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| {
            ctx.eval::<(), _>(GATE_BUNDLE).unwrap();
            ctx.globals().set("__gate_entry", "vehicle.validate").unwrap();
            ctx.globals().set("__gate_args", "not-json{").unwrap();
            let out: String = ctx.eval("citySdkGate.invoke(globalThis.__gate_entry, globalThis.__gate_args)").unwrap();
            let parsed: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(parsed["ok"], false);
            assert_eq!(parsed["diagnostics"][0]["code"], "embedded_gate_args_invalid");
        });
    }
}
