/* Claude IP 风险自检 — 自托管复刻版
 * 全部检测在浏览器本地完成：
 *  - Claude / Cloudflare 出口：各站 /cdn-cgi/trace（均带 Access-Control-Allow-Origin: *）
 *  - 国内服务视角出口：myip.ipip.net/json
 *  - IP 情报：ip-api.com（HTTP，含 proxy/hosting；失败回退 ipwho.is，无风险标记）
 *  - DNS 解析器出口：edns.ip-api.com（302 强制权威解析）
 *  - WebRTC/UDP：本地 RTCPeerConnection + STUN
 *  - 可用性：favicon 图片探针 ×3 取中位
 * 无自建后端、无上报；历史仅存 localStorage。
 */
'use strict';

/* ---------------- 工具 ---------------- */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function slot(root, name) { return $(`[data-slot="${name}"]`, root); }

async function fetchTimeout(url, ms, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({ cache: 'no-store', signal: ctrl.signal }, opts));
  } finally { clearTimeout(timer); }
}

function parseTrace(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function isV6(ip) { return String(ip || '').includes(':'); }

function isPrivateIp(ip) {
  if (!ip) return true;
  if (isV6(ip)) return /^(fe80|fc|fd)/i.test(ip) || ip === '::1';
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    // http://localhost 之外 clipboard API 可能不可用
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); return true;
    } catch (e2) { return false; }
  }
}

/* ---------------- 嵌入模式（工作台「测试」板 iframe） ----------------
 * ?embed=1 时：隐藏独立站外壳（品牌栏文案/页脚/关于卡），主题随宿主 ?theme= 传入；
 * IP 情报优先走宿主 Tauri 命令 ip_check_intel（应用进程不受 webview ATS 限制，
 * 可访问 ip-api 的 http 明文接口，保住代理/机房标记），失败再走浏览器直连链路。 */

const EMBED_PARAMS = new URLSearchParams(location.search);
const IS_EMBED = EMBED_PARAMS.get('embed') === '1';

(function initTheme() {
  const fromHost = EMBED_PARAMS.get('theme');
  const saved = localStorage.getItem('cic_theme');
  const preferLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = fromHost || saved || (preferLight ? 'light' : 'dark');
  if (IS_EMBED) document.documentElement.dataset.embed = '1';
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('cic_theme', next);
  });
})();

function invokeWithTimeout(command, args, ms) {
  const bridge = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (typeof bridge !== 'function') return Promise.reject(new Error('no tauri bridge'));
  return Promise.race([
    bridge(command, args),
    new Promise((_, reject) => setTimeout(() => reject(new Error('invoke timeout')), ms)),
  ]);
}

/* ---------------- 检测器 ---------------- */

async function fetchTrace(host) {
  const r = await fetchTimeout(`https://${host}/cdn-cgi/trace`, 9000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseTrace(await r.text());
}

async function detectClaude() {
  try {
    const t = await fetchTrace('claude.ai');
    if (!t.ip) throw new Error('no ip');
    return t;
  } catch (e) { return null; }
}

async function detectCloudflare() {
  try {
    const t = await fetchTrace('www.cloudflare.com');
    if (!t.ip) throw new Error('no ip');
    return t;
  } catch (e) { return null; }
}

async function detectChina() {
  try {
    const r = await fetchTimeout('https://myip.ipip.net/json', 8000);
    const j = await r.json();
    if (j.ret === 'ok' && j.data && j.data.ip) {
      const loc = (j.data.location || []).filter(Boolean).slice(0, 3).join(' · ');
      return { ip: j.data.ip, meta: loc };
    }
  } catch (e) {}
  return null;
}

async function intelFor(ip) {
  // 嵌入模式首选：宿主 Tauri 命令（应用进程不受 ATS/混合内容限制，可达 http 的 ip-api）
  if (IS_EMBED) {
    try {
      const j = await invokeWithTimeout('ip_check_intel', { ip }, 9000);
      if (j && j.status === 'success') return { source: 'ip-api.com（应用进程代取）', httpsOnly: false, data: j };
    } catch (e) { /* 落回浏览器直连链路 */ }
  }
  // 主源 ip-api：geo + proxy/hosting/mobile 标记。免费版仅 HTTP，
  // 若页面以 HTTPS 打开会被混合内容策略拦截 → 自动回退 ipwho.is（无风险标记）。
  try {
    const r = await fetchTimeout(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,isp,org,as,asname,mobile,proxy,hosting,query`,
      8000);
    const j = await r.json();
    if (j.status === 'success') return { source: 'ip-api.com', httpsOnly: false, data: j };
  } catch (e) {}
  try {
    const r = await fetchTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, 8000);
    const j = await r.json();
    if (j.success !== false && j.ip) {
      const c = j.connection || {};
      return {
        source: 'ipwho.is（回退）', httpsOnly: true,
        data: {
          country: j.country, countryCode: j.country_code,
          regionName: j.region, city: j.city,
          isp: c.isp, org: c.org, as: 'AS' + c.asn + (c.org ? ' ' + c.org : ''),
          mobile: null, proxy: null, hosting: null,
        },
      };
    }
  } catch (e) {}
  return null;
}

async function detectDns() {
  const r = await fetchTimeout('https://edns.ip-api.com/json', 10000);
  const j = await r.json();
  if (j && j.dns && j.dns.ip) return { ip: j.dns.ip, geo: j.dns.geo || '' };
  throw new Error('bad edns payload');
}

function detectWebrtc() {
  return new Promise(resolve => {
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
      });
    } catch (e) { resolve({ unsupported: true }); return; }

    const found = { srflx: null, hostIp: null, hostMdns: false };
    let settled = false;
    const finish = extra => {
      if (settled) return; settled = true;
      try { pc.close(); } catch (e) {}
      resolve(Object.assign(found, extra || {}));
    };

    pc.createDataChannel('ip-check');
    pc.onicecandidate = e => {
      if (!e.candidate) { finish({ complete: true }); return; } // 收集完毕
      // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
      const parts = String(e.candidate.candidate).split(' ');
      if (parts.length < 8 || parts[6] !== 'typ') return;
      const ip = parts[4], typ = parts[7];
      if (typ === 'srflx' && !found.srflx) found.srflx = ip;
      if (typ === 'host') {
        if (/\.local$/i.test(ip)) found.hostMdns = true;
        else if (!found.hostIp) found.hostIp = ip;
      }
    };
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .catch(() => finish({ error: true }));
    setTimeout(() => finish({ timeout: true }), 6000);
  });
}

/* 可用性探针：favicon 图片加载。
 * onload = 可达；onerror 也意味着 DNS/TCP/TLS 已完成（如 404/HTML），
 * 仅 8s 超时视为不可达。3 次取中位数。 */
function probeOnce(host) {
  return new Promise(resolve => {
    const img = new Image();
    const t0 = performance.now();
    let settled = false;
    const done = st => {
      if (settled) return; settled = true;
      resolve({ st, ms: Math.round(performance.now() - t0) });
    };
    img.onload = () => done('ok');
    img.onerror = () => done('reachable');
    img.src = `https://${host}/favicon.ico?_=${Math.random().toString(36).slice(2)}`;
    setTimeout(() => done('timeout'), 8000);
  });
}

async function probeLatency(host) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await probeOnce(host));
  const sorted = runs.map(r => r.ms).sort((a, b) => a - b);
  const timeouts = runs.filter(r => r.st === 'timeout').length;
  return { ms: sorted[1], ok: timeouts < 2 };
}

/* ---------------- 设备指纹 ---------------- */

function webglInfo() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    return { renderer: String(renderer || ''), vendor: String(vendor || '') };
  } catch (e) { return null; }
}

function canvasFp() {
  try {
    const c = document.createElement('canvas');
    c.width = 260; c.height = 60;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'top';
    ctx.font = '16px "Arial"';
    ctx.fillStyle = '#d97757';
    ctx.fillRect(4, 4, 90, 26);
    ctx.fillStyle = '#0d1117';
    ctx.fillText('Claude IP 检查 🐳 ≠ ≤', 8, 8);
    const grad = ctx.createLinearGradient(0, 0, 260, 60);
    grad.addColorStop(0, '#f85149'); grad.addColorStop(1, '#58a6ff');
    ctx.strokeStyle = grad; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(130, 30, 22, 0, Math.PI * 1.6); ctx.stroke();
    return fnv1a(c.toDataURL());
  } catch (e) { return null; }
}

function parseUA() {
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  let browser = '未知';
  const m = ua.match(/(Edg|Chrome|CriOS|Firefox|FxiOS|Safari)\/([\d.]+)/);
  if (m) browser = ({ Edg: 'Edge', Chrome: 'Chrome', CriOS: 'Chrome iOS', Firefox: 'Firefox', FxiOS: 'Firefox iOS', Safari: 'Safari' })[m[1]] + ' ' + m[2];
  return { platform, browser, ua };
}

function localeRegion() {
  const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
  for (const l of langs) {
    const m = String(l).match(/-([A-Za-z]{2})$/);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function renderFingerprint() {
  const fp = $('#fpGrid');
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || '未知';
  const off = -new Date().getTimezoneOffset() / 60;
  const offStr = 'UTC' + (off >= 0 ? '+' : '') + off;
  slot(fp, 'tz').textContent = `${tz}（${offStr}）`;
  slot(fp, 'lang').textContent = (navigator.languages || [navigator.language]).join(', ') || '未知';
  const ua = parseUA();
  slot(fp, 'os').textContent = `${ua.platform || '未知'} · ${ua.browser}`;
  slot(fp, 'touch').textContent = `maxTouchPoints = ${navigator.maxTouchPoints != null ? navigator.maxTouchPoints : '未知'}`;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  slot(fp, 'net').textContent = conn && conn.effectiveType ? `${conn.effectiveType}${conn.saveData ? ' · 省流模式' : ''}` : '不可用';
  slot(fp, 'dnt').textContent = navigator.doNotTrack === '1' ? '开启 (1)' : navigator.doNotTrack === '0' ? '关闭 (0)' : '未设置';
  const gl = webglInfo();
  slot(fp, 'webgl').textContent = gl ? (gl.renderer || gl.vendor || '未知（已混淆）') : '不可用';
  const cf = canvasFp();
  slot(fp, 'canvas').textContent = cf ? cf : '不可用';
  slot(fp, 'screen').textContent = `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`;
}

/* ---------------- 可用性 ---------------- */

async function runLatencyRow(rowId, host) {
  const row = $(rowId);
  const val = slot(row, 'val'), note = slot(row, 'note');
  val.textContent = '检测中…'; val.className = 'lat-val'; note.textContent = '';
  const r = await probeLatency(host);
  if (r.ok) {
    val.textContent = r.ms + ' ms';
    val.className = 'lat-val ok';
    note.textContent = r.ms > 100 ? '可达（亚洲到美国机房 >100ms 属正常）' : '可达';
  } else {
    val.textContent = '不可达';
    val.className = 'lat-val bad';
    note.textContent = '连接超时：当前网络可能未走代理，或节点故障';
  }
}

function runLatency() {
  runLatencyRow('#latClaude', 'claude.ai');
  runLatencyRow('#latAnthropic', 'www.anthropic.com');
}

/* ---------------- 信任分 ---------------- */

function computeScore(sig) {
  const reasons = [];
  let score = 100;
  const add = (penalty, text) => { score -= penalty; reasons.push({ penalty, text }); };

  if (sig.proxy === true) add(45, '情报库将出口标记为代理 / VPN / Tor');
  if (sig.hosting === true) add(25, '出口为机房 / 托管 IP（住宅 IP 通常更稳）');
  if (sig.ipv6) add(10, 'Claude 出口为 IPv6（不建议用于 Claude）');
  if (sig.geoMismatch) add(10, `浏览器地区（${sig.localeRegion}）与出口国家（${sig.ipCountry}）不一致`);
  if (sig.dnsLeak) add(5, '浏览器走代理但 DNS 解析器仍走本地直连（疑似 DNS 泄漏）');

  const negatives = reasons.slice();
  if (sig.proxy === false && sig.hosting === false) {
    reasons.push({ penalty: 0, good: true, text: '出口未被标记为代理或机房' });
  }
  if (sig.ipv6 === false) reasons.push({ penalty: 0, good: true, text: '出口为 IPv4' });
  if (!sig.geoMismatch && sig.ipCountry && sig.localeRegion) {
    reasons.push({ penalty: 0, good: true, text: '浏览器地区与出口国家一致' });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons, negatives };
}

function renderScore(result) {
  const zone = result.score >= 75 ? ['z-ok', '可信'] : result.score >= 50 ? ['z-mid', '中风险'] : ['z-bad', '高危'];
  $('#scoreNum').textContent = result.score;
  $('#scoreZone').textContent = zone[1];
  $('#scoreZone').className = 'score-zone ' + zone[0];
  $('#scoreNum').className = 'score-num ' + zone[0];
  $('#gaugeMarker').style.left = result.score + '%';

  const ul = $('#scoreReasons');
  ul.textContent = '';
  for (const r of result.reasons) {
    const li = document.createElement('li');
    if (r.good) li.className = 'good';
    const t = document.createElement('span'); t.textContent = r.text;
    const p = document.createElement('span'); p.className = 'penalty';
    p.textContent = r.penalty > 0 ? '−' + r.penalty : '✓';
    li.append(t, p);
    ul.appendChild(li);
  }
}

/* ---------------- 渲染 ---------------- */

function bindCopy(el) {
  el.title = '点击复制';
  el.addEventListener('click', async () => {
    const v = el.dataset.raw;
    if (!v) return;
    el.dataset.copied = '1';
    await copyText(v);
  });
}
$$('.ip-value').forEach(bindCopy);

function renderIpBox(box, ip, meta, bad) {
  const val = $('.ip-value', box), m = $('.ip-meta', box);
  if (ip) {
    val.textContent = ip; val.dataset.raw = ip;
    val.className = 'ip-value' + (box.id === 'boxClaude' ? ' big' : '') + (bad ? ' bad' : '');
  } else {
    val.textContent = '检测失败';
    val.className = 'ip-value' + (box.id === 'boxClaude' ? ' big' : '');
    delete val.dataset.raw;
  }
  m.textContent = meta || '—';
}

function renderSecBadge(key, state, text) {
  const el = $(`[data-sec="${key}"]`);
  if (!el) return;
  el.className = 'sec-badge' + (state ? ' s-' + state : '');
  $('.sec-state', el).textContent = text;
}

function resetUi() {
  $('#boxChina .ip-value').textContent = '检测中…';
  $('#boxCf .ip-value').textContent = '检测中…';
  $('#boxClaude .ip-value').textContent = '检测中…';
  $$('.ip-meta').forEach(el => { el.textContent = '—'; });
  $('#ipv6Banner').classList.add('hidden');
  $('#scoreNum').textContent = '—';
  $('#scoreZone').textContent = '评分中…';
  $('#scoreZone').className = 'score-zone';
  $('#gaugeMarker').style.left = '0%';
  $('#scoreReasons').textContent = '';
  ['proxy', 'hosting', 'warp'].forEach(k => renderSecBadge(k, '', '检测中'));
  ['region', 'ipType', 'asn', 'isp'].forEach(k => { slot($('#ipAttrs'), k).textContent = '检测中…'; });
}

/* ---------------- 主流程 ---------------- */

async function runAll() {
  resetUi();

  const safe = p => p.then(v => v, () => null);
  const chinaP = safe(detectChina());
  const cfP = safe(detectCloudflare());
  const claudeP = safe(detectClaude());
  const dnsP = safe(detectDns());
  const rtc = detectWebrtc(); // 自身永不 reject

  renderFingerprint();
  runLatency();

  const [china, cf, claude, dns] = await Promise.all([chinaP, cfP, claudeP, dnsP]);
  const rtcR = await rtc;

  renderIpBox($('#boxChina'), china && china.ip, china && china.meta, false);
  renderIpBox($('#boxCf'), cf && cf.ip, cf && cf.colo ? `CF 边缘 ${cf.colo} · ${isV6(cf.ip) ? 'IPv6' : 'IPv4'}` : (cf && cf.ip ? (isV6(cf.ip) ? 'IPv6' : 'IPv4') : null), false);
  const claudeMetaBits = [];
  if (claude) {
    if (claude.colo) claudeMetaBits.push('CF 边缘 ' + claude.colo);
    if (claude.loc) claudeMetaBits.push('IP 归属 ' + claude.loc);
    if (claude.warp === 'on') claudeMetaBits.push('WARP');
    if (claude.gateway === 'on') claudeMetaBits.push('Gateway');
  }
  renderIpBox($('#boxClaude'), claude && claude.ip, claudeMetaBits.join(' · '), false);

  const v6 = !!(claude && isV6(claude.ip));
  if (v6) $('#ipv6Banner').classList.remove('hidden');
  $('#boxClaude .ip-value').classList.toggle('bad', v6);

  // 情报（针对 Claude 出口）
  const intel = claude && claude.ip ? await intelFor(claude.ip) : null;
  const d = intel && intel.data;

  if (d) {
    slot($('#ipAttrs'), 'region').textContent = `${d.country || '—'}${d.regionName ? ' · ' + d.regionName : ''}${d.city ? ' · ' + d.city : ''}`;
    const bits = [];
    if (d.proxy === true) bits.push('代理/VPN');
    if (d.hosting === true) bits.push('机房');
    if (d.mobile === true) bits.push('移动网络');
    if (d.proxy === false && d.hosting === false && d.mobile === false) bits.push('住宅');
    if (d.proxy == null && d.hosting == null) bits.push('类型未知（回退源无标记）');
    let nativeNote = '';
    if (claude && claude.loc && d.countryCode) {
      nativeNote = claude.loc.toUpperCase() === d.countryCode.toUpperCase()
        ? ' · 原生（近似）' : ' · 疑似广播段（近似）';
    }
    slot($('#ipAttrs'), 'ipType').textContent = (bits.join(' / ') || '未知') + nativeNote;
    slot($('#ipAttrs'), 'asn').textContent = d.as || '—';
    slot($('#ipAttrs'), 'isp').textContent = d.isp || d.org || '—';
  } else {
    ['region', 'ipType', 'asn', 'isp'].forEach(k => { slot($('#ipAttrs'), k).textContent = '情报不可用'; });
  }
  $('#intelSource').textContent = '数据源：' + (intel ? intel.source + (intel.httpsOnly ? '' : '') : '不可用');

  renderSecBadge('proxy', d ? (d.proxy === true ? 'bad' : d.proxy === false ? 'ok' : 'na') : 'na',
    d ? (d.proxy === true ? '检测到' : d.proxy === false ? '未检测到' : '无数据') : '失败');
  renderSecBadge('hosting', d ? (d.hosting === true ? 'bad' : d.hosting === false ? 'ok' : 'na') : 'na',
    d ? (d.hosting === true ? '是' : d.hosting === false ? '否' : '无数据') : '失败');
  renderSecBadge('warp', claude ? (claude.warp === 'on' ? 'warn' : 'ok') : 'na',
    claude ? (claude.warp === 'on' ? '已启用' : '未启用') : '失败');

  // DNS 泄漏
  const dnsCard = $('#dnsExplain').closest('.card');
  const proxied = !!(claude && claude.ip && china && china.ip && claude.ip !== china.ip);
  if (dns && dns.ip) {
    slot(dnsCard, 'dnsIp').textContent = dns.ip;
    slot(dnsCard, 'dnsGeo').textContent = dns.geo || '—';
    let st, cls, explain;
    if (proxied && dns.ip === china.ip) {
      st = '疑似 DNS 泄漏'; cls = 'warn';
      explain = '浏览器访问 Claude 走了代理，但 DNS 解析器出口与国内直连出口一致：真实归属会暴露给每个被解析的域名。建议在代理客户端开启远程/代理侧 DNS。';
    } else if (proxied && claude.ip && dns.ip === claude.ip) {
      st = '正常（远程 DNS）'; cls = 'ok';
      explain = '解析器出口与代理出口一致，DNS 随代理走，未见泄漏。';
    } else if (!proxied) {
      st = '直连环境'; cls = 'ok';
      explain = '当前 Claude 出口与国内出口一致（直连或全局代理），解析器走本地属正常。';
    } else {
      st = '独立解析器'; cls = 'warn';
      explain = '解析器出口既非国内直连出口也非代理出口，常见于公共 DNS（8.8.8.8 / 1.1.1.1 等）。若为公共 DNS 通常无碍，但真实解析路径请结合代理规则确认。';
    }
    const sv = slot(dnsCard, 'dnsState');
    sv.textContent = st; sv.className = 'v ' + cls;
    $('#dnsExplain').textContent = explain;
  } else {
    const sv = slot(dnsCard, 'dnsState');
    sv.textContent = '检测失败'; sv.className = 'v bad';
    slot(dnsCard, 'dnsIp').textContent = '—'; slot(dnsCard, 'dnsGeo').textContent = '—';
    $('#dnsExplain').textContent = 'edns.ip-api.com 不可达（可能被当前网络或代理拦截），无法观测解析器出口。';
  }

  // WebRTC / UDP
  const rtcCard = $('#rtcExplain').closest('.card');
  const rState = slot(rtcCard, 'rtcState'), rIp = slot(rtcCard, 'rtcIp'), rLocal = slot(rtcCard, 'rtcLocal');
  if (rtcR.unsupported) {
    rState.textContent = '浏览器不支持'; rState.className = 'v warn';
  } else if (rtcR.srflx) {
    rIp.textContent = rtcR.srflx;
    const same = claude && claude.ip && rtcR.srflx === claude.ip;
    rState.textContent = same ? '未见泄漏' : 'UDP 出口与 Claude 出口不一致';
    rState.className = 'v ' + (same ? 'ok' : 'warn');
    $('#rtcExplain').textContent = same
      ? 'UDP（STUN 反射）出口与 Claude HTTP 出口一致，代理覆盖了 UDP。'
      : 'UDP 出口 ≠ Claude HTTP 出口：代理未覆盖 UDP 流量，WebRTC 场景会暴露该出口。若不使用浏览器实时通信可忽略；介意可在浏览器设置中关闭 WebRTC。';
  } else if (rtcR.hostIp || rtcR.hostMdns) {
    rState.textContent = '仅本机候选'; rState.className = 'v warn';
    $('#rtcExplain').textContent = '未取得 STUN 反射地址（STUN 服务器不可达或被拦截），无法判断 UDP 出口是否与 Claude 出口一致。';
  } else {
    rState.textContent = '不可用'; rState.className = 'v warn';
    $('#rtcExplain').textContent = '未收集到任何 ICE 候选：WebRTC 可能被浏览器策略或扩展禁用。';
  }
  rLocal.textContent = rtcR.hostMdns ? 'mDNS 混淆（浏览器隐私保护）'
    : (rtcR.hostIp ? (isPrivateIp(rtcR.hostIp) ? rtcR.hostIp + '（内网）' : rtcR.hostIp + '（⚠ 明文暴露）') : '—');

  // 评分
  const sig = {
    proxy: d ? d.proxy : null,
    hosting: d ? d.hosting : null,
    ipv6: v6,
    localeRegion: localeRegion(),
    ipCountry: d ? d.countryCode : (claude && claude.loc ? claude.loc.toUpperCase() : null),
  };
  sig.geoMismatch = !!(sig.localeRegion && sig.ipCountry && sig.localeRegion !== sig.ipCountry);
  sig.dnsLeak = !!(dns && dns.ip && proxied && dns.ip === (china && china.ip));
  const result = computeScore(sig);
  renderScore(result);

  pushHistory({
    t: Date.now(),
    ip: claude && claude.ip || '—',
    score: result.score,
    flags: [].concat(
      sig.proxy === true ? ['代理'] : [],
      sig.hosting === true ? ['机房'] : [],
      v6 ? ['IPv6'] : [],
      sig.geoMismatch ? ['地区不一致'] : [],
      sig.dnsLeak ? ['DNS泄漏'] : [],
    ),
  });
}

/* ---------------- 历史 ---------------- */

const HKEY = 'cic_history';

function pushHistory(entry) {
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) {}
  rows.unshift(entry);
  if (rows.length > 50) rows.length = 50;
  try { localStorage.setItem(HKEY, JSON.stringify(rows)); } catch (e) {}
  renderHistory();
}

function renderHistory() {
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) {}
  const tbody = $('#historyTable tbody');
  tbody.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4; td.className = 'empty';
    td.textContent = '暂无记录';
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    const zone = r.score >= 75 ? 'z-ok' : r.score >= 50 ? 'z-mid' : 'z-bad';
    const cells = [
      new Date(r.t).toLocaleString('zh-CN', { hour12: false }),
      r.ip,
      { text: r.score, cls: 'score-chip ' + zone },
      { text: r.flags && r.flags.length ? r.flags.join('、') : '—' },
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      if (typeof c === 'object') { td.textContent = c.text; td.className = c.cls || ''; }
      else {
        td.textContent = c;
        if (/:|\d+\.\d+\.\d+\.\d+/.test(c)) td.className = 'mono';
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

/* ---------------- 启动 ---------------- */

$('#rerunAll').addEventListener('click', () => { runAll(); });
$('#rerunLatency').addEventListener('click', () => { runLatency(); });
$('#clearHistory').addEventListener('click', () => {
  localStorage.removeItem(HKEY);
  renderHistory();
});
$('#year').textContent = new Date().getFullYear();

renderHistory();
runAll();
