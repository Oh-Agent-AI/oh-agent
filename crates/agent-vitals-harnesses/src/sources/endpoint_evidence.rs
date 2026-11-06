//! 跨执行环境的「端点 / 配置证据」读取器（自动归因规格 A12、§10.2 层②）。
//!
//! **为什么在这里**：会话日志普遍不记端点——claude-code 实测 44,827 条 deepseek 记录里
//! `requestId` 只出现 176 次，日志正文里的中转主机名全是**对话内容**（§10.1 表格里
//! claude-code 那格写的就是"启动环境变量，日志不记"）。能回答"这批用量打到谁的端点"
//! 的只有**配置**。而每个执行环境的配置形状都不一样，所以这里是「按执行环境声明用哪个文件、
//! 哪个字段」的提取器层——判定器（`billing_preview::auto_verdict`）只吃中立结构，
//! 不认识任何执行环境的文件格式。
//!
//! **隐私边界**（与 `harnesses/*/sources/account.rs` 同纪律）：每个读取器**白名单取键**。
//! 各执行环境的凭据就挨在同一个文件里（claude `env.ANTHROPIC_AUTH_TOKEN`、workbuddy
//! `models[].apiKey`、pi `maxTokens`、cline `providers.*.tokenSource`），读取器连它们的值
//! 都不复制出来；`EndpointEvidence` 没有放凭据的槽位。**Hermes 的 `.env` 整体不读**
//! （§10.1 已定案：凭据文件，不读），所以 hermes 在这里恒为 `None`。
//!
//! **证据强度一律 `ConfigCurrent`(4)**：配置说的是"现在"，历史事实可能用另一个端点。
//! 所以它只能把"官方还是中转"变成一次确认，永远不能单独判定归属（P3）。

use std::collections::BTreeMap;
use std::path::Path;

use agent_vitals_provider::EvidenceBasis;
use serde_json::Value;

/// 一个执行环境在配置面暴露出来的端点证据。**能带出去的只有这些字段**——凭据连槽位都没有。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointEvidence {
    pub harness: String,
    /// 选中的基址（多个端点时是哪一个由各读取器的语义决定）。
    pub base_url: Option<String>,
    /// 选中基址的主机名。
    pub endpoint_host: Option<String>,
    /// 配置里出现过的**全部**端点主机（去重升序）。多于一个时，判定器不会替用户挑一个
    /// ——它只知道"配置里有中转"，不知道这批用量用的是哪一个。
    pub endpoint_hostnames: Vec<String>,
    /// **逐模型**配置的端点（模型 id → 端点主机）。workbuddy 与 pi 的配置本来就是
    /// "每个模型一条、各带自己的 url/baseUrl"的形状——那是最精确的证据，比执行环境级列表强，
    /// 所以单列出来（验收审查 iteration 7 #2：把它们压成一个列表就丢了配对的精度，
    /// 于是 MiniMax 走官方端点这件事被"配置里有中转"淹没）。
    pub model_endpoints: BTreeMap<String, String>,
    /// 这份配置是**逐模型**写的（workbuddy/pi：每个模型一条、各带端点）。为真时，
    /// 执行环境级的 `gateway_named_models` 列表**不是**对全执行环境的陈述——它只是"某些模型的
    /// id 带前缀"，不能拿来给另一个模型下结论（验收审查 iteration 8 #1：workbuddy 的真实
    /// 文件里既有 `deepseek/…` 也有裸 `MiniMax-M3`，把前者当执行环境级信号会把 MiniMax 说成经中转）。
    pub per_model_config: bool,
    /// 配置里显式声明的服务商名（dsh `agent-default-model.provider`）。**只作展示**：
    /// 实测本机 dsh 写 `deepseek-official` 而基址是中转，名字会说谎，主机名不会。
    pub provider_name: Option<String>,
    /// 模型映射里带 `vendor/model` 前缀的条目：官方端点不需要厂商 id，中转才需要
    /// （用户 2026-09-16 指出）。
    pub gateway_named_models: Vec<String>,
    /// **时间线证据**（`config-time-bound`(5)，来自 cc-switch 的 provider 表 + 每日备份，
    /// 见 `sources/ccswitch.rs`）：这个执行环境配置过的每个中转、它**何时建立**、哪些快照里
    /// 它是当前选中。上面各字段说的是"现在"，这里说的是"曾经存在过什么、从何时起"——
    /// 判定器据此把「那时还不存在的中转」从候选里剔掉（2026-09-17：胜算云 09-11 深夜
    /// 才建，09-09 的 395 次 gpt-5.6-sol 不可能经它）。**不进** `endpoint_hostnames`：那是
    /// 当前配置的陈述，把历史条目混进去会让官方形状的用量平白多一条
    /// `config.endpoint.conflict`。
    pub timeline: Vec<RelayRecord>,
    pub evidence_basis: EvidenceBasis,
    pub source: String,
}

/// 一条"配置过的中转"的时间信息。`created_at_ms` 缺失（旧版 cc-switch 没写）时不能
/// 用于排除，只作展示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayRecord {
    pub endpoint_host: String,
    /// 用户在 cc-switch 里起的名字（只作展示：本机两条不同中转都叫 shengsuanyun）。
    pub label: String,
    pub created_at_ms: Option<i64>,
    pub is_current: bool,
    /// 每日备份快照里它被选中的时刻（UTC epoch ms，升序去重）。
    pub active_at_ms: Vec<i64>,
}

impl EndpointEvidence {
    fn new(harness: &str, source: String) -> Self {
        EndpointEvidence {
            harness: harness.to_string(),
            base_url: None,
            endpoint_host: None,
            endpoint_hostnames: Vec::new(),
            model_endpoints: BTreeMap::new(),
            per_model_config: false,
            provider_name: None,
            gateway_named_models: Vec::new(),
            timeline: Vec::new(),
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source,
        }
    }

    /// 收一个候选基址：记进 `endpoint_hostnames`，并让**第一个**成为 `base_url`/`endpoint_host`
    /// （各读取器按语义决定顺序；单端点的执行环境自然只有一个）。
    fn push_endpoint(&mut self, url: &str) {
        let Some(hostname) = hostname_of(url) else { return };
        if self.endpoint_host.is_none() {
            self.base_url = Some(url.trim().to_string());
            self.endpoint_host = Some(hostname.clone());
        }
        if !self.endpoint_hostnames.contains(&hostname) {
            self.endpoint_hostnames.push(hostname);
        }
    }

    /// 记一条"这个模型配的是哪个端点"。同一个模型重复出现时**保留第一个**
    /// （配置文件顺序即用户摆放顺序；不猜"最后一个覆盖"）。
    fn observe_model_endpoint(&mut self, model: &str, url: &str) {
        let (Some(model), Some(hostname)) = (Some(model.trim()), hostname_of(url)) else { return };
        if model.is_empty() {
            return;
        }
        self.push_endpoint(url);
        self.model_endpoints.entry(model.to_string()).or_insert(hostname);
    }

    fn observe_model(&mut self, model: &str) {
        let model = model.trim();
        if model.contains('/') && !self.gateway_named_models.iter().any(|m| m == model) {
            self.gateway_named_models.push(model.to_string());
        }
    }

    /// 证据是否为空——没有端点也没有前缀痕迹的条目不进判定（不猜）。
    fn has_signal(&self) -> bool {
        !self.endpoint_hostnames.is_empty() || !self.gateway_named_models.is_empty() || self.provider_name.is_some()
            || !self.timeline.is_empty()
    }

    fn finish(mut self) -> Option<Self> {
        self.endpoint_hostnames.sort();
        self.endpoint_hostnames.dedup();
        self.gateway_named_models.sort();
        if !self.has_signal() {
            return None;
        }
        Some(self)
    }
}

/// 模型名的"最后一段"：配置常带厂商前缀（`deepseek/deepseek-v4-flash`）而事实常是
/// 上游裸名（`deepseek-v4-flash`），比对时去掉前缀层。
pub fn model_tail(model: &str) -> &str {
    model.rsplit('/').next().unwrap_or(model)
}

/// 取 URL 的主机名：去 scheme、去路径、去端口（仅全数字）、去尾点、转小写。
pub(crate) fn hostname_of(url: &str) -> Option<String> {
    let mut value = url.trim().to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }
    if let Some((_, rest)) = value.split_once("://") {
        value = rest.to_string();
    }
    // userinfo（`https://user:pass@harness/`）只取 `@` 之后——凭据不进结构。
    if let Some((_, rest)) = value.rsplit_once('@') {
        value = rest.to_string();
    }
    value = value.split('/').next().unwrap_or(&value).to_string();
    if let Some((hostname, port)) = value.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            value = hostname.to_string();
        }
    }
    let value = value.trim_end_matches('.').to_string();
    if value.is_empty() || !value.contains('.') {
        return None;
    }
    Some(value)
}

/// 中转/服务商的展示标签 = 注册域（`router.shengsuanyun.com` → `shengsuanyun.com`）。
///
/// 返回 `Option`：**认不出就返回 `None`，绝不编一个出来**（验收审查 iteration 5 #1：
/// 早期版本把 `relay.co.uk` 判成 `co.uk`、把 `10.0.0.7` 判成 `0.7`，用户确认后会把
/// 这个字符串写成声明的 provider_id）。这里不是公共后缀表（PSL），只是一张
/// 「二级公共后缀」小表 + IP 拒判；覆盖不到的后缀宁可不给标签，让上层只显示主机名。
pub fn relay_label_of(raw: &str) -> Option<String> {
    // 入口先归一化：调用方现在都传已归一的主机名，但函数**不能靠调用方守规矩**——
    // 直接喂一个 URL 会原样吐回 `https://user:pass@harness/`（验收审查 iteration 7 #5）。
    let hostname = hostname_of(raw)?;
    if hostname.contains(':') {
        return None;
    }
    let labels: Vec<&str> = hostname.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    // 字面 IPv4（也涵盖 `10.0.0.7` 这类内网地址）：没有"注册域"可言。
    if labels.iter().all(|l| l.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    // 形如 `com.cn` / `co.uk` / `ne.jp` 的公共后缀：再往前取一层才是注册域。
    const SECOND_LEVEL: [&str; 12] = ["com", "net", "org", "gov", "edu", "co", "ac", "ne", "or", "go", "in", "com"];
    let last = labels[labels.len() - 1];
    let second = labels[labels.len() - 2];
    let take = if last.len() == 2 && SECOND_LEVEL.contains(&second) { 3 } else { 2 };
    if labels.len() < take {
        // 例如裸 `co.uk`：候选本身就是公共后缀 → 不给标签。
        return None;
    }
    let candidate = labels[labels.len() - take..].join(".");
    // 候选仍是一个公共后缀（`co.uk`、`com.cn`）→ 拒判，不冒充付款方。
    if candidate.split('.').count() == 2
        && candidate.split('.').next().is_some_and(|first| SECOND_LEVEL.contains(&first))
        && candidate.split('.').nth(1).is_some_and(|tail| tail.len() == 2)
    {
        return None;
    }
    Some(candidate)
}

/// 汇总所有执行环境的端点证据。读不到的执行环境**不进 map**（判定器按"没有证据"处理）。
pub fn read_all(home: &Path) -> BTreeMap<String, EndpointEvidence> {
    let mut out = BTreeMap::new();
    for reader in [
        read_claude as fn(&Path) -> Option<EndpointEvidence>,
        read_codex,
        read_pi,
        read_dsh,
        read_workbuddy,
    ] {
        if let Some(evidence) = reader(home) {
            out.insert(evidence.harness.clone(), evidence);
        }
    }
    // 第二层：cc-switch 的 provider 时间线（`config-time-bound`），按执行环境挂到 `timeline`。
    // 执行环境当前没有端点证据（比如 codex 此刻走官方、config.toml 没有 model_providers
    // 段）也要挂——正是"现在走官方、上周走过中转"的情形需要历史条目来解释。
    if let Some(cc) = super::ccswitch::read(home) {
        for (harness, records) in cc.relays_by_harness {
            let evidence = out.entry(harness.clone()).or_insert_with(|| {
                let mut e = EndpointEvidence::new(&harness, String::new());
                e.evidence_basis = cc.evidence_basis;
                e
            });
            evidence.source = if evidence.source.is_empty() {
                cc.source.clone()
            } else {
                format!("{} + {}", evidence.source, cc.source)
            };
            evidence.timeline = records;
        }
    }
    out
}

/// codex `config.toml` 里 `[model_providers.*]` 段的全部 `base_url`（按出现顺序）。
/// TOML 只按行取窄形状（不进 toml 依赖：本 crate 的供应链约束不允许；形状漂移时读不到
/// 比读错好）。`read_codex` 与 cc-switch 读取器（它存的就是这段 TOML 文本）共用。
pub(crate) fn codex_toml_base_urls(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_providers = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_providers = line.starts_with("[model_providers.");
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim().trim_matches('"'));
        if in_providers && key == "base_url" && !value.is_empty() {
            out.push(value.to_string());
        }
    }
    out
}

/// **claude-code**：`~/.claude/settings.json`（`settings.local.json` 覆盖）的 `env`。
/// 只读 5 个白名单键——同一个 `env` 里就挨着 `ANTHROPIC_AUTH_TOKEN`。
pub fn read_claude(home: &Path) -> Option<EndpointEvidence> {
    const ALLOWED: [&str; 5] = [
        "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ];
    const MODEL_KEYS: [&str; 4] = [
        "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ];
    let mut evidence = EndpointEvidence::new("claude-code", "~/.claude/settings.json env".to_string());
    let mut source_file = None;
    for name in ["settings.json", "settings.local.json"] {
        let path = home.join(".claude").join(name);
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(block) = doc.get("env").and_then(Value::as_object) else { continue };
        // 白名单投影：其余键（尤其凭据）连值都不复制出来。
        let picked: Vec<(&str, &str)> = ALLOWED.iter()
            .filter_map(|k| block.get(*k).and_then(Value::as_str).map(|v| (*k, v.trim())))
            .filter(|(_, v)| !v.is_empty())
            .collect();
        for (key, value) in &picked {
            if *key == "ANTHROPIC_BASE_URL" {
                evidence.base_url = None;
                evidence.endpoint_host = None;
                evidence.endpoint_hostnames.clear();
                evidence.push_endpoint(value);
            } else if MODEL_KEYS.contains(key) {
                evidence.observe_model(value);
            }
        }
        source_file = Some(name.to_string());
    }
    evidence.source = format!("~/.claude/{} env", source_file.unwrap_or_else(|| "settings.json".into()));
    evidence.finish()
}

/// **codex**：`~/.codex/config.toml` 的 `[model_providers.<name>] base_url`。
/// 本机实测没有这一段（走官方路径），读不到就是 `None`——不猜。TOML 只按行取窄形状
/// （不进 toml 依赖：本 crate 的供应链约束不允许；形状漂移时读不到比读错好）。
pub fn read_codex(home: &Path) -> Option<EndpointEvidence> {
    let path = home.join(".codex").join("config.toml");
    let text = std::fs::read_to_string(&path).ok()?;
    let mut evidence = EndpointEvidence::new("codex", "~/.codex/config.toml".to_string());
    for url in codex_toml_base_urls(&text) {
        evidence.push_endpoint(&url);
    }
    let mut in_providers = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_providers = line.starts_with("[model_providers.");
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim().trim_matches('"'));
        if !in_providers && key == "model" {
            evidence.observe_model(value);
        }
    }
    evidence.finish()
}

/// **pi**：`~/.pi/agent/models-store.json` 的 `models[].baseUrl` 与 `models[].id`。
pub fn read_pi(home: &Path) -> Option<EndpointEvidence> {
    let path = home.join(".pi").join("agent").join("models-store.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let doc: Value = serde_json::from_str(&text).ok()?;
    let mut evidence = EndpointEvidence::new("pi", "~/.pi/agent/models-store.json".to_string());
    evidence.per_model_config = true;
    for (provider, spec) in doc.as_object()? {
        // provider 名本身就是"经哪一家"的痕迹，但它不是主机名，只作展示。
        if evidence.provider_name.is_none() {
            evidence.provider_name = Some(provider.clone());
        }
        for model in spec.get("models").and_then(Value::as_array).into_iter().flatten() {
            let id = model.get("id").and_then(Value::as_str);
            let url = model.get("baseUrl").and_then(Value::as_str);
            match (id, url) {
                // pi 的 store 也是逐模型带 baseUrl —— 逐模型记（比执行环境级列表精确）。
                (Some(id), Some(url)) => {
                    evidence.observe_model_endpoint(id, url);
                    evidence.observe_model(id);
                }
                (Some(id), None) => evidence.observe_model(id),
                (None, Some(url)) => evidence.push_endpoint(url),
                (None, None) => {}
            }
        }
    }
    evidence.finish()
}

/// **dsh**：`~/.dsh/settings.yaml` 里 **LLM 段**（段名以 `llm-` 开头）的 `baseURL` 与
/// `models[].id`；`agent-default-model.provider` 作展示名（**只作展示**：它是用户写的
/// 标签，本机写着 `deepseek-official`）。段名启发式的理由：本机 `web-search-deepseek`
/// 段也带 `baseURL`（指向中转），但那是搜索不是 LLM，算进来会给出错误的端点；本机
/// `llm-deepseek.baseURL` 是官方的 `https://api.deepseek.com`。
/// `.credentials.yaml` **整体不读**。
pub fn read_dsh(home: &Path) -> Option<EndpointEvidence> {
    let path = home.join(".dsh").join("settings.yaml");
    let text = std::fs::read_to_string(&path).ok()?;
    let mut evidence = EndpointEvidence::new("dsh", "~/.dsh/settings.yaml".to_string());
    let mut section = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // 顶格 `name:` = 段；缩进的 `key: value` = 段内条目。
        let indent = line.len() - line.trim_start().len();
        // YAML 列表项写作 `- key: value`（dsh 的 `models:` 就是），前缀要剥掉，
        // 否则 `- id: …` 会被当成键名 `- id`，带前缀的模型 id 一个都收不到。
        let trimmed = trimmed.strip_prefix("- ").unwrap_or(trimmed).trim_start();
        let (key, value) = match trimmed.split_once(':') {
            Some((k, v)) => (k.trim(), v.trim().trim_matches('"')),
            None => continue,
        };
        if indent == 0 {
            section = key.to_string();
            continue;
        }
        let in_llm = section.starts_with("llm-");
        if in_llm && key == "baseURL" {
            evidence.push_endpoint(value);
        } else if in_llm && key == "id" {
            evidence.observe_model(value);
        } else if section == "agent-default-model" && key == "provider" {
            evidence.provider_name = Some(value.to_string());
        } else if section == "agent-default-model" && key == "model" {
            evidence.observe_model(value);
        }
    }
    evidence.finish()
}

/// **workbuddy**：`~/.workbuddy/models.json` 的 `[].url`。真机形状是
/// `{id, name, vendor, url, supports…}`——**每个模型一条、各带自己的端点**
/// （`MiniMax-M3 → api.minimaxi.com`、`deepseek/… → beta-router.shengsuanyun.com`），
/// 所以逐模型记下来；`gateway_named_models` 取 `id`（曾经误读 `model` 键——真机上
/// 根本没有这个键，于是这个执行环境的前缀信号一直是死的；验收审查 iteration 7 #4）。
/// `apiKey` 与 `url` 同一个对象——白名单取键，凭据不进结构。
pub fn read_workbuddy(home: &Path) -> Option<EndpointEvidence> {
    let path = home.join(".workbuddy").join("models.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let doc: Value = serde_json::from_str(&text).ok()?;
    let mut evidence = EndpointEvidence::new("workbuddy", "~/.workbuddy/models.json".to_string());
    evidence.per_model_config = true;
    for entry in doc.as_array().into_iter().flatten() {
        let url = entry.get("url").and_then(Value::as_str);
        let model = entry.get("id").and_then(Value::as_str);
        if let (Some(url), Some(model)) = (url, model) {
            evidence.observe_model_endpoint(model, url);
            evidence.observe_model(model);
        } else if let Some(url) = url {
            evidence.push_endpoint(url);
        }
    }
    evidence.finish()
}

// **hermes**：`.env` 是凭据文件，§10.1 已定案**整体不读**——hermes 在这里恒为 `None`。
// 刻意不写 reader 函数，也没有 `read_hermes`：新增执行环境时对着 `read_all` 的那张表想一遍
// "这个执行环境的端点在哪个文件、那个文件里还有没有凭据"。

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("av-endpoint-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(home: &Path, rel: &str, body: &str) {
        let path = home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// claude：白名单投影；同一个 env 里的令牌绝不进结构（P1）。**穷举解构**是本测试的
    /// 关键：结构新增字段会在这里编译失败（验收审查 iteration 5 #4：只断言"投影字段里
    /// 没有令牌"抓不到"结构里多了个令牌字段"）。
    #[test]
    fn claude_reads_only_whitelisted_keys_and_never_the_token() {
        let h = home("claude");
        write(&h, ".claude/settings.json", r#"{
          "env": {
            "ANTHROPIC_BASE_URL": "https://router.shengsuanyun.com/api",
            "ANTHROPIC_MODEL": "deepseek/deepseek-v4-pro-0813",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-v4-flash",
            "ANTHROPIC_AUTH_TOKEN": "sk-SECRET-DO-NOT-LEAK",
            "ANTHROPIC_API_KEY": "sk-ANOTHER-SECRET",
            "OTHER": "x"
          }, "model": "sonnet" }"#);
        let e = read_claude(&h).expect("evidence");
        let EndpointEvidence {
            harness, base_url, endpoint_host, endpoint_hostnames, model_endpoints, per_model_config,
            provider_name, gateway_named_models, timeline, evidence_basis, source,
        } = e;
        assert!(timeline.is_empty(), "no cc-switch in this HOME → no timeline");
        assert_eq!(harness, "claude-code");
        assert_eq!(base_url.as_deref(), Some("https://router.shengsuanyun.com/api"));
        assert_eq!(endpoint_host.as_deref(), Some("router.shengsuanyun.com"));
        assert_eq!(endpoint_hostnames, vec!["router.shengsuanyun.com"]);
        assert!(model_endpoints.is_empty(), "claude has one global base URL, no per-model endpoints");
        assert!(!per_model_config, "claude's env is a harness-level mapping set, not per-model");
        assert_eq!(provider_name, None);
        assert_eq!(gateway_named_models, vec!["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro-0813"]);
        assert_eq!(evidence_basis, EvidenceBasis::ConfigCurrent);
        assert!(source.contains("settings.json"));
        let debug = format!("{:?}", read_claude(&h).unwrap());
        for forbidden in ["SECRET", "sk-", "AUTH_TOKEN", "API_KEY"] {
            assert!(!debug.contains(forbidden), "leaked {forbidden}: {debug}");
        }
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn claude_local_settings_override_and_missing_config_is_none() {
        let h = home("claude-local");
        assert!(read_claude(&h).is_none(), "no config → None, never a guess");
        write(&h, ".claude/settings.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com/v1"}}"#);
        write(&h, ".claude/settings.local.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://router.shengsuanyun.com/api"}}"#);
        let e = read_claude(&h).unwrap();
        assert_eq!(e.endpoint_host.as_deref(), Some("router.shengsuanyun.com"), "local overrides global");
        let _ = std::fs::remove_dir_all(&h);
    }

    /// codex：只有 `[model_providers.*]` 段里的 `base_url` 算端点；本机没有这一段 → None。
    #[test]
    fn codex_reads_model_providers_section_only() {
        let h = home("codex");
        write(&h, ".codex/config.toml", "model = \"gpt-5.6-terra\"\n\n[projects.\"/tmp/x\"]\ntrust_level = \"trusted\"\n");
        assert!(read_codex(&h).is_none(), "no model_providers → no endpoint evidence");
        write(&h, ".codex/config.toml", r#"model = "deepseek/deepseek-v4-flash"
base_url = "https://api.deepseek.com"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example.com/v1"
env_key = "RELAY_KEY"
"#);
        let e = read_codex(&h).unwrap();
        assert_eq!(e.endpoint_host.as_deref(), Some("relay.example.com"), "only the providers section counts");
        assert_eq!(e.gateway_named_models, vec!["deepseek/deepseek-v4-flash"]);
        let _ = std::fs::remove_dir_all(&h);
    }

    /// pi：`models[].baseUrl` + `models[].id`；`maxTokens` 之类的同对象字段不进结构。
    #[test]
    fn pi_reads_model_base_urls_and_ids() {
        let h = home("pi");
        write(&h, ".pi/agent/models-store.json", r#"{"openai-codex":{"models":[
          {"id":"gpt-5.3-codex-spark","name":"Spark","baseUrl":"https://chatgpt.com/backend-api","maxTokens":128000},
          {"id":"zhipu/glm-5.3","name":"GLM","baseUrl":"https://open.bigmodel.cn/api"}]}}"#);
        let e = read_pi(&h).unwrap();
        assert_eq!(e.provider_name.as_deref(), Some("openai-codex"));
        assert_eq!(e.endpoint_hostnames, vec!["chatgpt.com", "open.bigmodel.cn"]);
        assert_eq!(e.gateway_named_models, vec!["zhipu/glm-5.3"]);
        assert_eq!(e.model_endpoints.get("gpt-5.3-codex-spark").map(String::as_str), Some("chatgpt.com"));
        assert_eq!(e.model_endpoints.get("zhipu/glm-5.3").map(String::as_str), Some("open.bigmodel.cn"));
        let debug = format!("{:?}", e);
        assert!(!debug.contains("maxTokens"), "{debug}");
        let _ = std::fs::remove_dir_all(&h);
    }

    /// dsh：只认 **LLM 段**（`llm-*`）的 baseURL。本机 `web-search-deepseek` 段也带同一个
    /// 中转基址，但那是搜索不是 LLM——把它算进来会给出错误的端点。
    #[test]
    fn dsh_reads_llm_sections_only() {
        let h = home("dsh");
        write(&h, ".dsh/settings.yaml", "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nweb-search-deepseek:\n  baseURL: https://router.shengsuanyun.com/api/v1\nllm-deepseek:\n  models:\n    - id: deepseek-v4-flash\n      name: DeepSeek V4 Flash\n    - id: deepseek/deepseek-v4.1-flash\n      name: Relay Form\n  baseURL: https://api.deepseek.com\n");
        let e = read_dsh(&h).unwrap();
        assert_eq!(e.endpoint_host.as_deref(), Some("api.deepseek.com"), "only llm-* sections count");
        assert_eq!(e.provider_name.as_deref(), Some("deepseek-official"));
        assert!(!e.endpoint_hostnames.contains(&"router.shengsuanyun.com".to_string()));
        assert_eq!(e.gateway_named_models, vec!["deepseek/deepseek-v4.1-flash"],
            "a YAML list item is parsed (`- id:`), and only the vendor-prefixed id counts: {e:?}");
        let _ = std::fs::remove_dir_all(&h);
    }

    /// workbuddy：真机形状 `{id, name, vendor, url, …}`——**逐模型**端点（这是最精确的
    /// 证据：MiniMax 走官方端点、deepseek 走中转，同一个文件里各不相同）。`apiKey` 与
    /// `url` 同一个对象但绝不进结构。曾经误读不存在的 `model` 键 → 前缀信号恒空
    /// （验收审查 iteration 7 #4），所以这里用真机键名钉住。
    #[test]
    fn workbuddy_records_per_model_endpoints_and_no_credentials() {
        let h = home("workbuddy");
        write(&h, ".workbuddy/models.json", r#"[
          {"id":"MiniMax-M3","name":"MiniMax-M3","vendor":"Custom","url":"https://api.minimaxi.com/v1","apiKey":"sk-WB-SECRET"},
          {"id":"deepseek/deepseek-v4-flash","name":"deepseek/deepseek-v4-flash","vendor":"Custom","url":"https://beta-router.shengsuanyun.com/api","apiKey":"sk-WB-SECRET-2"}
        ]"#);
        let e = read_workbuddy(&h).unwrap();
        assert_eq!(e.endpoint_hostnames, vec!["api.minimaxi.com", "beta-router.shengsuanyun.com"]);
        assert_eq!(e.model_endpoints.get("MiniMax-M3").map(String::as_str), Some("api.minimaxi.com"));
        assert_eq!(e.model_endpoints.get("deepseek/deepseek-v4-flash").map(String::as_str),
            Some("beta-router.shengsuanyun.com"));
        assert_eq!(e.gateway_named_models, vec!["deepseek/deepseek-v4-flash"],
            "read from the real `id` key, not the non-existent `model` key");
        let debug = format!("{:?}", e);
        assert!(!debug.contains("SECRET") && !debug.contains("apiKey"), "{debug}");
        let _ = std::fs::remove_dir_all(&h);
    }

    /// 中转标签：注册域可认，公共后缀与 IP **宁可不给标签也不编一个**（验收审查 #1）。
    #[test]
    fn relay_label_refuses_public_suffixes_and_ip_literals() {
        assert_eq!(relay_label_of("router.shengsuanyun.com").as_deref(), Some("shengsuanyun.com"));
        assert_eq!(relay_label_of("Beta-Router.ShengSuanYun.com.").as_deref(), Some("shengsuanyun.com"));
        assert_eq!(relay_label_of("relay.foo.com.au").as_deref(), Some("foo.com.au"));
        assert_eq!(relay_label_of("a.b.example.com.cn").as_deref(), Some("example.com.cn"));
        assert_eq!(relay_label_of("api.deepseek.com.evil.example").as_deref(), Some("evil.example"));
        // 以下四条是旧实现的错处：`co.uk` / `0.7` 会被当成付款方名字写进声明。
        assert_eq!(relay_label_of("relay.co.uk").as_deref(), Some("relay.co.uk"));
        assert_eq!(relay_label_of("co.uk"), None);
        assert_eq!(relay_label_of("10.0.0.7"), None);
        assert_eq!(relay_label_of("localhost"), None);
        // 直接喂 URL：入口归一化（userinfo 被剥掉，凭据不可能从标签漏出去），
        // 认不出的（非数字端口残留 `:`）拒判。
        assert_eq!(relay_label_of("https://user:pass@harness.example/").as_deref(), Some("harness.example"));
        assert_eq!(relay_label_of("router.shengsuanyun.com:8443x"), None);
    }

    #[test]
    fn hostname_of_strips_scheme_userinfo_port_path_and_trailing_dot() {
        assert_eq!(hostname_of("HTTPS://User:Pa55@Router.ShengSuanYun.com:443/api/").as_deref(), Some("router.shengsuanyun.com"));
        assert_eq!(hostname_of("https://router.shengsuanyun.com./api").as_deref(), Some("router.shengsuanyun.com"));
        assert_eq!(hostname_of("not-a-url"), None);
        assert_eq!(hostname_of(""), None);
    }
}
