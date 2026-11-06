# Claude IP 风险自检（自托管复刻版）

复刻 [ip.net.coffee/claude](https://ip.net.coffee/claude/) 的能力：检测访问 Claude 时的出口 IP、信任分、代理/机房标记、Claude 可达性、DNS 与 WebRTC 泄漏、设备指纹与本地历史。独立实现，无自建后端、无任何数据上报——所有检测由浏览器直接向公共接口发起。

## 运行

零依赖，任意静态服务器即可（**必须以 HTTP 打开**，原因见下）：

```bash
cd ip-claude-check
python3 -m http.server 8787
# 浏览器打开 http://localhost:8787
```

## 与 Agent Vitals 工作台的关系

工作台「测试」板的 **Claude 访问风险自检** 已是原生 React 实现（`apps/desktop/ui-dev/react/src/features/test/ipcheck.ts` + `IpCheckSection.tsx`），与本目录的独立静态版**同源不同体**：探测手法一致（trace / ipip / edns / STUN / favicon 探针），但 React 版**零网络**——全部出站探测收敛在 Rust 模块 `apps/desktop/src-tauri/src/ip_check.rs`（单一 `ip_check_run` 命令，按 `scutil --proxy` 对齐系统代理路由），前端只渲染报告。两份代码没有同步关系；改探测手法时建议两边一起改。


## 能力与实现原理

| 功能 | 实现 |
| --- | --- |
| Claude AI 出口 IP | `https://claude.ai/cdn-cgi/trace`（Cloudflare 边缘观测，CORS 开放；附赠 `colo` 边缘节点、`loc` IP 归属、`warp`/`gateway` 标记） |
| Cloudflare 出口 IP | `https://www.cloudflare.com/cdn-cgi/trace` |
| 国内服务视角出口 | `https://myip.ipip.net/json`（ipip 为中国视角 geo 库） |
| 信任分 0–100 | 本地固定规则：代理/VPN/Tor −45、机房 −25、浏览器地区与出口国不一致 −10、IPv6 −10、DNS 泄漏 −5；规则在页面上明示 |
| IP 属性 | ip-api.com（国家/城市/ASN/ISP + `proxy`/`hosting`/`mobile` 标记），失败回退 ipwho.is（仅 geo，无风险标记，页面如实标注） |
| 住宅/机房/原生 | `proxy`/`hosting`/`mobile` 标记组合；「原生」为近似判定（Cloudflare `loc` 与 geo 库国家一致） |
| Claude 可用性 | 对 claude.ai / www.anthropic.com 的 favicon 发起 3 次图片探针取中位数；`onerror` 也视为可达（握手已完成），仅超时判不可达 |
| DNS 泄漏 | `https://edns.ip-api.com/json`：302 到随机子域，强制解析器向权威 NS 查询，暴露解析器出口；与国内出口/代理出口比对判定 |
| WebRTC/UDP 泄漏 | 本地 `RTCPeerConnection` + Google STUN，取 srflx 候选为 UDP 出口；host 候选被 mDNS 混淆时如实标注 |
| 设备指纹 | 时区/语言/系统浏览器/触摸/网络/DNT/WebGL 渲染器/Canvas 哈希（FNV-1a）/屏幕 |
| 历史 | localStorage（`cic_history`，最多 50 条），可一键清除 |

## 与原站的差异

- 信任分不用黑盒评分 API，而是**规则透明**的本地计算，扣分明细直接展示。
- 免费数据源没有独立的 Tor / 爬虫 / 滥用记录字段——徽章如实显示「不支持」，不猜测。接入 IPQS、ipinfo Privacy Detection 等商业源即可补全（改 `app.js` 里的 `intelFor()`）。
- 无自建后端，因此也不存在「国内节点」「Claude 专用探测节点」这类服务端能力；国内出口用 ipip 的公共服务近似。

## 已知限制

- **必须 HTTP 打开**：ip-api 免费版仅支持 HTTP，HTTPS 页面会因混合内容策略拦截该项（自动回退 ipwho.is，风险标记显示「无数据」）。若要 HTTPS 部署，自建一个小反代或改用付费 HTTPS 情报源。
- ip-api 免费额度 45 req/min（本页每次全量检测仅 1 次）。
- 「原生 IP」是双 geo 库交叉的近似判定，不是注册库级结论。
- STUN（UDP）与 edns 探测在部分网络/代理环境下不可达，页面按项降级并说明原因。

## 隐私

无上报、无统计、无 Cookie；唯一本地状态是主题偏好与检测历史（localStorage）。对第三方的可见性等同于你直接访问上表所列公共接口。
