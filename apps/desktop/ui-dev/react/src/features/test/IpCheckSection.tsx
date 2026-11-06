import { useEffect, useMemo, useRef, useState } from "react";
import { readIpCheckReport, safeUiError, type IpCheckReport, type IpCheckTrace } from "../../lib/tauri";
import { StatusPill } from "../../components/ui/StatusPill";
import { message, resolvedLanguage, useLanguage, type MessageKey } from "../../lib/i18n";
import { computeScore, isV6, loadHistory, localeRegion, saveHistory, type HistoryRow } from "./ipcheck";

const tx = (key: MessageKey, params: Record<string, string | number> = {}): string => message(key, resolvedLanguage(), params);

const JOIN = " · ";

function metaChips(trace: IpCheckTrace | null): string {
  if (!trace) return "";
  const parts: string[] = [];
  if (trace.colo) parts.push(tx("qt.ipEdge", { node: trace.colo }));
  if (trace.loc) parts.push(tx("qt.ipOwner", { country: trace.loc }));
  if (trace.warp === "on") parts.push("WARP");
  return parts.join(JOIN);
}

function typeText(claude: IpCheckTrace | null, intel: IpCheckReport["intel"]): string {
  if (!intel) return tx("qt.ipIntelUnavailable");
  const parts: string[] = [];
  if (intel.proxy === true) parts.push(tx("qt.ipTypeProxy"));
  if (intel.hosting === true) parts.push(tx("qt.ipTypeHosting"));
  if (intel.mobile === true) parts.push(tx("qt.ipTypeMobile"));
  if (intel.proxy === false && intel.hosting === false && intel.mobile === false) parts.push(tx("qt.ipTypeResidential"));
  if (intel.proxy == null && intel.hosting == null) parts.push(tx("qt.ipTypeUnknownFlags"));
  if (claude?.loc && intel.countryCode) {
    parts.push(claude.loc.toUpperCase() === intel.countryCode.toUpperCase() ? tx("qt.ipTypeNative") : tx("qt.ipTypeBroadcast"));
  }
  return parts.length ? parts.join(JOIN) : tx("qt.ipTypeUnknown");
}

function parseBrowser(): string {
  const ua = navigator.userAgent;
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  const match = /(Edg|Chrome|CriOS|Firefox|FxiOS|Safari)\/([\d.]+)/.exec(ua);
  const names: Record<string, string> = { Edg: "Edge", Chrome: "Chrome", CriOS: "Chrome iOS", Firefox: "Firefox", FxiOS: "Firefox iOS", Safari: "Safari" };
  const browser = match ? `${names[match[1]] ?? match[1]} ${match[2]}` : "";
  return [platform, browser].filter(Boolean).join(JOIN);
}

function webglRenderer(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(renderer ?? "");
  } catch {
    return "";
  }
}

const PROXY_NOTE: Record<IpCheckReport["proxy_mode"], MessageKey | null> = {
  direct: null,
  static: null,
  pac: "qt.ipProxyNotePac",
  socks: "qt.ipProxyNoteSocks",
};

export function IpCheckSection() {
  useLanguage();
  const [report, setReport] = useState<IpCheckReport | null>(null);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const generation = useRef(0);

  useEffect(() => { setHistory(loadHistory()); }, []);

  // 默认待机：探测只在用户点击「开始检测」后才发起（主动诊断，不随页面加载触发）。
  const refresh = () => {
    const current = ++generation.current;
    setHasRun(true);
    setRunning(true);
    setError(null);
    void readIpCheckReport().then((next) => {
      if (current !== generation.current) return;
      setReport(next);
      setRunning(false);
      const row = historyRow(next);
      if (row) setHistory(saveHistory([row, ...loadHistory().filter((existing) => existing.t !== row.t)]));
    }).catch((reason: unknown) => {
      if (current !== generation.current) return;
      setError(safeUiError(reason, tx("qt.ipFail")));
      setRunning(false);
    });
  };

  const claudeV6 = report ? isV6(report.claude?.ip) : false;
  const exits = [report?.china?.ip, report?.cloudflare?.ip, report?.claude?.ip];
  const exitsKnown = exits.filter((ip): ip is string => !!ip);
  const exitsIdentical = exitsKnown.length === 3 && new Set(exitsKnown).size === 1;

  const score = useMemo(() => {
    if (!report) return null;
    const proxied = !!(report.claude?.ip && report.china?.ip && report.claude.ip !== report.china.ip);
    return computeScore({
      proxy: report.intel?.proxy ?? null,
      hosting: report.intel?.hosting ?? null,
      ipv6: report.claude ? isV6(report.claude.ip) : null,
      localeRegion: localeRegion(),
      ipCountry: report.intel?.countryCode ?? report.claude?.loc?.toUpperCase() ?? null,
      dnsLeak: !!(report.dns?.ip && proxied && report.dns.ip === report.china?.ip),
    });
  }, [report]);
  const zone = score ? (score.score >= 75 ? { tone: "success" as const, label: tx("qt.ipZoneOk"), cls: "ipcheck-zone-ok" } : score.score >= 50 ? { tone: "warning" as const, label: tx("qt.ipZoneMid"), cls: "ipcheck-zone-mid" } : { tone: "danger" as const, label: tx("qt.ipZoneBad"), cls: "ipcheck-zone-bad" }) : null;

  const dnsState = useMemo(() => {
    if (!report) return { tone: "neutral" as const, label: tx("qt.ipChecking") };
    if (!report.dns) return { tone: "neutral" as const, label: tx("qt.ipFail") };
    if (!report.claude?.ip) return { tone: "neutral" as const, label: tx("qt.ipUndecidable") };
    const proxied = !!(report.china?.ip && report.claude.ip !== report.china.ip);
    if (proxied && report.dns.ip === report.china?.ip) return { tone: "warning" as const, label: tx("qt.ipDnsLeak") };
    if (proxied && report.dns.ip === report.claude.ip) return { tone: "success" as const, label: tx("qt.ipDnsRemote") };
    if (proxied) return { tone: "neutral" as const, label: tx("qt.ipDnsIndependent") };
    return { tone: "neutral" as const, label: tx("qt.ipDnsDirect") };
  }, [report]);

  const stunState = useMemo(() => {
    if (!report) return { tone: "neutral" as const, label: tx("qt.ipChecking") };
    if (!report.stun) return { tone: "neutral" as const, label: tx("qt.ipRtcUnreachable") };
    if (!report.claude?.ip) return { tone: "neutral" as const, label: tx("qt.ipUndecidable") };
    return report.stun.ip === report.claude.ip
      ? { tone: "success" as const, label: tx("qt.ipRtcMatch") }
      : { tone: "warning" as const, label: tx("qt.ipRtcMismatch") };
  }, [report]);

  const fingerprint = useMemo(() => {
    const offset = -new Date().getTimezoneOffset() / 60;
    return {
      tz: `${Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""} (UTC${offset >= 0 ? "+" : ""}${offset})`,
      lang: (navigator.languages ?? [navigator.language]).join(", "),
      os: parseBrowser(),
      webgl: webglRenderer(),
      screen: `${screen.width}×${screen.height} @${window.devicePixelRatio ?? 1}x`,
    };
  }, []);

  const latencyNote = report?.latency.some((probe) => probe.ok && probe.ms !== null && probe.ms > 100)
    ? tx("qt.ipLatencyNote")
    : report?.latency.some((probe) => !probe.ok) ? tx("qt.ipUnreachableNote") : "";

  const proxyNote = report ? PROXY_NOTE[report.proxy_mode] : null;

  return <section className="ipcheck" aria-labelledby="ipcheck-title">
    <div className="ipcheck-head">
      <div>
        <p className="eyebrow">{tx("qt.ipEyebrow")}</p>
        <h3 id="ipcheck-title">{tx("qt.ipTitle")}</h3>
        <p>{tx("qt.ipBody")}</p>
      </div>
      <button className="button button-secondary button-small" type="button" onClick={refresh} disabled={running}>{running ? tx("qt.ipRunning") : hasRun ? tx("qt.ipRun") : tx("qt.ipStart")}</button>
    </div>

    {!hasRun && <div className="ipcheck-card ipcheck-idle" role="note"><p>{tx("qt.ipIdleNote")}</p></div>}

    {hasRun && <>
    {error && <div className="ipcheck-banner" role="alert">{error}</div>}
    {claudeV6 && <div className="ipcheck-banner" role="alert">{tx("qt.ipV6")}</div>}
    {proxyNote && <div className="ipcheck-banner" role="status">{tx(proxyNote)}</div>}

    <div className={`ipcheck-card ipcheck-exits ${exitsIdentical ? "ipcheck-exits-same" : ""}`} aria-label={tx("qt.ipExitTitle")}>
      {exitsIdentical
        ? <>
          <span className="ipcheck-exit-label">{tx("qt.ipExitAll")}</span>
          <strong className="ipcheck-exit-ip">{report?.claude?.ip}</strong>
          <span className="ipcheck-exit-meta">{metaChips(report?.claude ?? null)}</span>
        </>
        : <div className="ipcheck-exit-grid">
          {([["china", tx("qt.ipExitChina"), report?.china?.ip ?? null, report?.china?.location ?? ""],
             ["cf", tx("qt.ipExitCf"), report?.cloudflare?.ip ?? null, metaChips(report?.cloudflare ?? null)],
             ["claude", tx("qt.ipExitClaude"), report?.claude?.ip ?? null, metaChips(report?.claude ?? null)]] as const).map(([id, label, ip, meta]) => (
            <div key={id} className={`ipcheck-exit ${id === "claude" ? "ipcheck-exit-primary" : ""}`}>
              <span className="ipcheck-exit-label">{label}</span>
              <strong className={`ipcheck-exit-ip ${ip === null && !running ? "ipcheck-value-failed" : ""} ${id === "claude" && claudeV6 ? "ipcheck-value-failed" : ""}`}>
                {ip ?? (running ? tx("qt.ipChecking") : tx("qt.ipFail"))}
              </strong>
              <span className="ipcheck-exit-meta">{meta}</span>
            </div>
          ))}
        </div>}
    </div>

    <div className="ipcheck-card ipcheck-score" aria-label={tx("qt.ipScoreTitle")}>
      <div className="ipcheck-score-main">
        <div className="ipcheck-gauge">
          <div className="ipcheck-gauge-track"><span className="ipcheck-gauge-marker" style={{ left: `${score ? score.score : 0}%` }} /></div>
          <div className="ipcheck-gauge-scale"><span>0</span><span>50</span><span>75</span><span>100</span></div>
        </div>
        <div className="ipcheck-score-value">
          <strong className={zone?.cls ?? ""}>{score ? score.score : running ? tx("qt.ipChecking") : "—"}</strong>
          {zone && <StatusPill tone={zone.tone}>{zone.label}</StatusPill>}
        </div>
      </div>
      {score && score.reasons.length > 0 && <ul className="ipcheck-reasons">
        {score.reasons.map((reason) => <li key={reason.key} className={reason.kind === "good" ? "ipcheck-reason-good" : ""}>
          <span>{tx(reason.key as MessageKey, reason.params ?? {})}</span>
          <span aria-hidden="true">{reason.kind === "good" ? "✓" : "−"}</span>
        </li>)}
      </ul>}
      <p className="ipcheck-note">{tx("qt.ipScoreNote")}</p>
    </div>

    <div className="ipcheck-card ipcheck-detail" aria-label={tx("qt.ipDetailTitle")}>
      <h4>{tx("qt.ipDetailTitle")}</h4>
      <dl className="ipcheck-kv">
        <div><dt>{tx("qt.ipRegion")}</dt><dd>{report?.intel ? [report.intel.country, report.intel.regionName, report.intel.city].filter(Boolean).join(JOIN) : running ? tx("qt.ipChecking") : tx("qt.ipIntelUnavailable")}</dd></div>
        <div><dt>{tx("qt.ipTypeLabel")}</dt><dd>{running && !report?.intel ? tx("qt.ipChecking") : typeText(report?.claude ?? null, report?.intel ?? null)}</dd></div>
        <div><dt>{tx("qt.ipAsn")}</dt><dd>{report?.intel?.as ?? (running ? tx("qt.ipChecking") : tx("qt.ipIntelUnavailable"))}</dd></div>
        <div><dt>{tx("qt.ipIsp")}</dt><dd>{report?.intel?.isp ?? report?.intel?.org ?? (running ? tx("qt.ipChecking") : tx("qt.ipIntelUnavailable"))}</dd></div>
      </dl>
    </div>

    <div className="ipcheck-card ipcheck-latency" aria-label={tx("qt.ipLatencyTitle")}>
      <h4>{tx("qt.ipLatencyTitle")}</h4>
      <div className="ipcheck-latency-rows">
        {(report?.latency ?? []).map((probe) => <div key={probe.host} className="ipcheck-latency-row">
          <code>{probe.host}</code>
          <strong className={probe.ok ? "ipcheck-latency-ok" : "ipcheck-latency-bad"}>{probe.ok ? `${probe.ms} ms` : tx("qt.ipUnreachable")}</strong>
        </div>)}
        {!report && <span className="ipcheck-meta">{tx("qt.ipChecking")}</span>}
      </div>
      {latencyNote && <p className="ipcheck-note">{latencyNote}</p>}
    </div>

    <div className="ipcheck-card ipcheck-leaks" aria-label={tx("qt.ipLeakTitle")}>
      <h4>{tx("qt.ipLeakTitle")}</h4>
      <div className="ipcheck-leak-rows">
        <div className="ipcheck-leak-row">
          <span className="ipcheck-leak-label">{tx("qt.ipDnsResolver")}</span>
          <span className="ipcheck-leak-value"><code>{report?.dns?.ip ?? (running ? tx("qt.ipChecking") : tx("qt.ipFail"))}</code>{report?.dns?.geo && <small>{report.dns.geo}</small>}</span>
          <StatusPill tone={dnsState.tone}>{dnsState.label}</StatusPill>
        </div>
        <div className="ipcheck-leak-row">
          <span className="ipcheck-leak-label">{tx("qt.ipRtcLabel")}</span>
          <span className="ipcheck-leak-value"><code>{report?.stun?.ip ?? (running ? tx("qt.ipChecking") : "—")}</code></span>
          <StatusPill tone={stunState.tone}>{stunState.label}</StatusPill>
        </div>
      </div>
    </div>

    <div className="ipcheck-card ipcheck-fp" aria-label={tx("qt.ipFpTitle")}>
      <h4>{tx("qt.ipFpTitle")}</h4>
      <dl className="ipcheck-kv">
        <div><dt>{tx("qt.ipFpTz")}</dt><dd>{fingerprint.tz}</dd></div>
        <div><dt>{tx("qt.ipFpLang")}</dt><dd>{fingerprint.lang}</dd></div>
        <div><dt>{tx("qt.ipFpOs")}</dt><dd>{fingerprint.os}</dd></div>
        <div><dt>{tx("qt.ipFpScreen")}</dt><dd>{fingerprint.screen}</dd></div>
        <div className="ipcheck-kv-wide"><dt>{tx("qt.ipFpWebgl")}</dt><dd>{fingerprint.webgl || tx("qt.ipFpUnavailable")}</dd></div>
      </dl>
    </div>

    <div className="ipcheck-card ipcheck-history" aria-label={tx("qt.ipHistoryTitle")}>
      <div className="ipcheck-history-head">
        <h4>{tx("qt.ipHistoryTitle")}</h4>
        <button className="button button-secondary button-small" type="button" onClick={() => { saveHistory([]); setHistory([]); }} disabled={history.length === 0}>{tx("qt.ipHistoryClear")}</button>
      </div>
      {history.length === 0
        ? <p className="ipcheck-meta">{tx("qt.ipHistoryEmpty")}</p>
        : <div className="ipcheck-table-wrap"><table className="ipcheck-table">
          <thead><tr><th scope="col">{tx("qt.ipHistoryTime")}</th><th scope="col">{tx("qt.ipHistoryIp")}</th><th scope="col">{tx("qt.ipHistoryScore")}</th><th scope="col">{tx("qt.ipHistoryFlags")}</th></tr></thead>
          <tbody>{history.map((row) => <tr key={row.t}>
            <td>{new Date(row.t).toLocaleString(resolvedLanguage() === "en" ? "en-US" : "zh-CN", { hour12: false })}</td>
            <td><code>{row.ip}</code></td>
            <td><strong className={row.score >= 75 ? "ipcheck-zone-ok" : row.score >= 50 ? "ipcheck-zone-mid" : "ipcheck-zone-bad"}>{row.score}</strong></td>
            <td>{row.flags.length ? row.flags.join(JOIN) : "—"}</td>
          </tr>)}</tbody>
        </table></div>}
    </div>
    </>}
  </section>;
}

function historyRow(report: IpCheckReport): HistoryRow | null {
  if (!report.claude?.ip) return null;
  const proxied = !!(report.china?.ip && report.claude.ip !== report.china.ip);
  const dnsLeak = !!(report.dns?.ip && proxied && report.dns.ip === report.china?.ip);
  const locale = localeRegion();
  const country = report.intel?.countryCode ?? report.claude.loc?.toUpperCase() ?? null;
  const { score, reasons } = computeScore({
    proxy: report.intel?.proxy ?? null,
    hosting: report.intel?.hosting ?? null,
    ipv6: isV6(report.claude.ip),
    localeRegion: locale,
    ipCountry: country,
    dnsLeak,
  });
  const has = (key: string) => reasons.some((reason) => reason.key === key);
  const flags: string[] = [];
  if (report.intel?.proxy === true) flags.push(tx("qt.ipFlagProxy"));
  if (report.intel?.hosting === true) flags.push(tx("qt.ipFlagHosting"));
  if (isV6(report.claude.ip)) flags.push(tx("qt.ipFlagV6"));
  if (has("qt.ipScoreGeo")) flags.push(tx("qt.ipFlagGeo"));
  if (dnsLeak) flags.push(tx("qt.ipFlagDns"));
  return { t: Date.now(), ip: report.claude.ip, score, flags };
}
