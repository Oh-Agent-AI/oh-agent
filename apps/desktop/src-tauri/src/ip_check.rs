//! 「测试」板 Claude IP 风险自检的网络探测套件。
//!
//! React 源码受离线包契约约束（不得出现远端 URL / 网络客户端），因此本工具的
//! 全部出站探测都收敛在这里，由应用进程执行，前端只拿一份报告渲染。
//!
//! 路由保真：探测必须与浏览器/Claude 流量走同一条路，结果才是「Claude 看到的
//! 你」。reqwest 默认不读系统代理，所以先解析 `scutil --proxy`（macOS）：
//! 静态 HTTP(S) 代理 → 显式套用到 client；TUN 增强模式在网关层透明接管，无需
//! 处理；PAC / 仅 SOCKS 无法低成本复刻浏览器路由，如实降级并在报告里标注。
//!
//! 出站面：仅对公共接口发 GET（trace / ipip / edns / ip-api / favicon 探针 /
//! STUN），查询对象就是待检事实本身，不携带任何本地数据；无缓存、无持久化。

use serde_json::{json, Value};
use std::net::UdpSocket;
use std::time::{Duration, Instant};

const USER_AGENT: &str = "agent-vitals-ip-check/1";
const STUN_SERVERS: [&str; 2] = ["stun.l.google.com:19302", "stun1.l.google.com:19302"];

#[derive(PartialEq)]
enum ProxyMode { Direct, Static, Pac, Socks }

fn read_system_proxy() -> (ProxyMode, Option<String>) {
    // scutil 输出是 `Key : Value` 行；只在主线程外短暂执行一次（毫秒级）。
    let output = std::process::Command::new("scutil").arg("--proxy").output();
    let text = match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).into_owned(),
        _ => return (ProxyMode::Direct, None),
    };
    let mut flags: std::collections::HashMap<&str, bool> = std::collections::HashMap::new();
    let mut values: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        let value = value.trim();
        if value == "1" || value == "0" {
            flags.insert(key, value == "1");
        } else if !value.is_empty() {
            values.insert(key, value);
        }
    }
    let endpoint = |proxy_key: &str, port_key: &str| -> Option<String> {
        let host = values.get(proxy_key).copied()?;
        let port = values.get(port_key).copied()?;
        if host.is_empty() || port.is_empty() { return None; }
        // 混合端口（Clash/Surge 常见）接受 http CONNECT；host/port 来自系统配置非自由文本 URL
        Some(format!("http://{host}:{port}"))
    };
    if *flags.get("HTTPSEnable").unwrap_or(&false) {
        if let Some(proxy) = endpoint("HTTPSProxy", "HTTPSPort") { return (ProxyMode::Static, Some(proxy)); }
    }
    if *flags.get("HTTPEnable").unwrap_or(&false) {
        if let Some(proxy) = endpoint("HTTPProxy", "HTTPPort") { return (ProxyMode::Static, Some(proxy)); }
    }
    if *flags.get("ProxyAutoConfigEnable").unwrap_or(&false) { return (ProxyMode::Pac, None); }
    if *flags.get("SOCKSEnable").unwrap_or(&false) { return (ProxyMode::Socks, None); }
    (ProxyMode::Direct, None)
}

fn build_client() -> (reqwest::Client, &'static str) {
    let (mode, proxy) = read_system_proxy();
    let mode_label = match mode {
        ProxyMode::Direct => "direct",
        ProxyMode::Static => "static",
        ProxyMode::Pac => "pac",
        ProxyMode::Socks => "socks",
    };
    let mut builder = reqwest::Client::builder().user_agent(USER_AGENT);
    if let Some(proxy) = proxy.as_deref().and_then(|url| reqwest::Proxy::all(url).ok()) {
        builder = builder.proxy(proxy);
    }
    (builder.build().unwrap_or_else(|_| reqwest::Client::new()), mode_label)
}

async fn get_text(client: &reqwest::Client, url: &str, timeout: Duration) -> Result<String, String> {
    let response = client.get(url).timeout(timeout).send().await.map_err(|e| format!("request failed: {e}"))?;
    let code = response.status();
    if !code.is_success() { return Err(format!("http {code}")); }
    response.text().await.map_err(|e| format!("body failed: {e}"))
}

async fn fetch_trace(client: &reqwest::Client, host: &str) -> Option<Value> {
    let text = get_text(client, &format!("https://{host}/cdn-cgi/trace"), Duration::from_secs(9)).await.ok()?;
    let mut fields: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') { fields.insert(key.trim(), value.trim()); }
    }
    let ip = fields.get("ip").copied()?;
    if !is_lookup_ip(ip) { return None; }
    Some(json!({
        "ip": ip,
        "colo": fields.get("colo").copied().unwrap_or(""),
        "loc": fields.get("loc").copied().unwrap_or(""),
        "warp": fields.get("warp").copied().unwrap_or(""),
    }))
}

fn is_lookup_ip(ip: &str) -> bool {
    let ip = ip.trim();
    if ip.is_empty() || ip.len() > 45 { return false; }
    let v4: Vec<&str> = ip.split('.').collect();
    if v4.len() == 4 {
        return v4.iter().all(|part| {
            !part.is_empty() && part.len() <= 3 && part.bytes().all(|b| b.is_ascii_digit()) && part.parse::<u8>().is_ok()
        });
    }
    // IPv6：十六进制冒号，允许 IPv4 尾段
    ip.contains(':') && ip.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
}

async fn fetch_china(client: &reqwest::Client) -> Option<Value> {
    let text = get_text(client, "https://myip.ipip.net/json", Duration::from_secs(8)).await.ok()?;
    let payload: Value = serde_json::from_str(&text).ok()?;
    let data = payload.get("data")?;
    let ip = data.get("ip")?.as_str()?;
    if !is_lookup_ip(ip) { return None; }
    let location = data.get("location").and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).take(3).collect::<Vec<_>>().join(" · "))
        .unwrap_or_default();
    Some(json!({ "ip": ip, "location": location }))
}

async fn fetch_dns(client: &reqwest::Client) -> Option<Value> {
    let text = get_text(client, "https://edns.ip-api.com/json", Duration::from_secs(10)).await.ok()?;
    let payload: Value = serde_json::from_str(&text).ok()?;
    let dns = payload.get("dns")?;
    let ip = dns.get("ip")?.as_str()?;
    if !is_lookup_ip(ip) { return None; }
    Some(json!({ "ip": ip, "geo": dns.get("geo").and_then(Value::as_str).unwrap_or("") }))
}

/// ip-api 免费版（http 明文、免 key）是唯一带 proxy/hosting 标记的无凭据源；
/// webview 拿不到它（ATS），由本进程代取。
async fn fetch_intel(client: &reqwest::Client, ip: &str) -> Option<Value> {
    if !is_lookup_ip(ip) { return None; }
    let url = format!("http://ip-api.com/json/{ip}?fields=status,message,country,countryCode,regionName,city,isp,org,as,asname,mobile,proxy,hosting,query");
    let text = get_text(client, &url, Duration::from_secs(8)).await.ok()?;
    let payload: Value = serde_json::from_str(&text).ok()?;
    if payload.get("status").and_then(Value::as_str) != Some("success") { return None; }
    Some(payload)
}

async fn probe_host_once(client: &reqwest::Client, host: &str) -> Option<u64> {
    let started = Instant::now();
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let sent = client.get(format!("https://{host}/favicon.ico?_={nonce:x}"))
        .timeout(Duration::from_secs(8)).send().await;
    // 任何 HTTP 应答（含 404/跳转）都证明 DNS+TCP+TLS 通了；仅超时/网络错判不可达。
    sent.ok().map(|_| started.elapsed().as_millis() as u64)
}

async fn probe_latency(client: &reqwest::Client, host: &str) -> Value {
    let mut samples: Vec<u64> = Vec::new();
    for _ in 0..3 {
        if let Some(ms) = probe_host_once(client, host).await { samples.push(ms); }
    }
    if samples.len() < 2 { return json!({ "host": host, "ms": null, "ok": false }); }
    samples.sort_unstable();
    json!({ "host": host, "ms": samples[1], "ok": true })
}

// ---- STUN 反射（UDP 出口）：RFC5389 Binding，std UdpSocket 走阻塞线程池 ----

fn parse_stun_xor_mapped(message: &[u8], transaction: &[u8; 12]) -> Option<String> {
    if message.len() < 20 || message[0] != 0x01 { return None; }
    if &message[8..20] != transaction { return None; }
    let key: Vec<u8> = message[4..20].to_vec(); // magic cookie + transaction id
    let mut offset = 20;
    while offset + 4 <= message.len() {
        let attr_type = u16::from_be_bytes([message[offset], message[offset + 1]]);
        let attr_len = u16::from_be_bytes([message[offset + 2], message[offset + 3]]) as usize;
        let start = offset + 4;
        if start + attr_len > message.len() { break; }
        if attr_type == 0x0020 && attr_len >= 8 {
            let family = message[start + 1];
            let port_xored = u16::from_be_bytes([message[start + 2], message[start + 3]]);
            let _ = port_xored ^ 0x2112; // 端口不用于展示，只证明是合法 XOR-MAPPED
            if family == 0x01 {
                let octets = u32::from_be_bytes([message[start + 4], message[start + 5], message[start + 6], message[start + 7]])
                    ^ u32::from_be_bytes([key[0], key[1], key[2], key[3]]);
                return Some(format!("{}.{}.{}.{}", octets >> 24, (octets >> 16) & 0xff, (octets >> 8) & 0xff, octets & 0xff));
            }
            if family == 0x02 && attr_len >= 20 && key.len() == 16 {
                let mut groups = [0u16; 8];
                for index in 0..8 {
                    let raw = u16::from_be_bytes([message[start + 4 + index * 2], message[start + 5 + index * 2]]);
                    groups[index] = raw ^ u16::from_be_bytes([key[index * 2], key[index * 2 + 1]]);
                }
                return Some(std::net::Ipv6Addr::from(groups).to_string());
            }
        }
        offset = start + attr_len + ((4 - (attr_len % 4)) % 4);
    }
    None
}

fn stun_reflect_blocking(server: &str) -> Option<String> {
    let mut request = [0u8; 20];
    request[1] = 0x01; // Binding Request
    request[4..8].copy_from_slice(&0x2112_A442u32.to_be_bytes());
    let transaction: [u8; 12] = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).ok()?
        .as_nanos().to_be_bytes()[4..16].try_into().ok()?;
    request[8..20].copy_from_slice(&transaction);
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    socket.connect(server).ok()?;
    socket.send(&request).ok()?;
    let mut buffer = [0u8; 512];
    let read = socket.recv(&mut buffer).ok()?;
    parse_stun_xor_mapped(&buffer[..read], &transaction)
}

async fn stun_reflection() -> Option<String> {
    for server in STUN_SERVERS {
        let server = server.to_string();
        if let Some(mirrored) = tauri::async_runtime::spawn_blocking(move || stun_reflect_blocking(&server))
            .await.ok().flatten()
        {
            return Some(mirrored);
        }
    }
    None
}

/// 一次自检的完整报告：每个探针独立成败，前端按字段如实渲染降级态。
#[tauri::command]
pub async fn ip_check_run() -> Result<Value, String> {
    let (client, proxy_mode) = build_client();
    let (claude, cloudflare, china, dns, latency, stun) = tokio::join!(
        fetch_trace(&client, "claude.ai"),
        fetch_trace(&client, "www.cloudflare.com"),
        fetch_china(&client),
        fetch_dns(&client),
        async {
            let claude_site = probe_latency(&client, "claude.ai").await;
            let anthropic = probe_latency(&client, "www.anthropic.com").await;
            vec![claude_site, anthropic]
        },
        stun_reflection(),
    );
    let claude_ip = claude.as_ref().and_then(|trace| trace.get("ip")).and_then(Value::as_str).map(str::to_owned);
    let intel = match claude_ip.as_deref() {
        Some(ip) => fetch_intel(&client, ip).await,
        None => None,
    };
    Ok(json!({
        "proxy_mode": proxy_mode,
        "claude": claude,
        "cloudflare": cloudflare,
        "china": china,
        "dns": dns,
        "intel": intel,
        "latency": latency,
        "stun": stun.map(|ip| json!({ "ip": ip })).unwrap_or(Value::Null),
    }))
}
