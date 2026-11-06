/**
 * Claude IP 自检的纯本地逻辑（评分 / 历史 / 指纹辅助）。
 * 网络探测全部在 Rust 侧 `ip_check.rs`（离线包契约：React 源码不得含远端
 * URL / 网络客户端），本文件只消费 `readIpCheckReport` 的报告。
 */

import type { IpCheckReport, IpCheckTrace } from "../../lib/tauri";

export type { IpCheckReport, IpCheckTrace };

export function isV6(ip: string | null | undefined): boolean {
  return typeof ip === "string" && ip.includes(":");
}

export function localeRegion(): string | null {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
  for (const language of languages) {
    const match = /^([a-z]{2,3})-([A-Za-z]{2})$/.exec(String(language));
    if (match) return match[2].toUpperCase();
  }
  return null;
}

export type ScoreSignal = {
  proxy: boolean | null;
  hosting: boolean | null;
  ipv6: boolean | null; // null = Claude 出口未知，不下任何结论
  localeRegion: string | null;
  ipCountry: string | null;
  dnsLeak: boolean;
};
export type ScoreReason = { kind: "bad" | "good"; key: string; params?: Record<string, string> };

/** 信任分：本地固定规则（独立版同款），只对已知的信号下结论。 */
export function computeScore(signal: ScoreSignal): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let score = 100;
  const penalize = (amount: number, key: string, params?: Record<string, string>) => {
    score -= amount;
    reasons.push({ kind: "bad", key, params });
  };
  if (signal.proxy === true) penalize(45, "qt.ipScoreProxy");
  if (signal.hosting === true) penalize(25, "qt.ipScoreHosting");
  if (signal.ipv6 === true) penalize(10, "qt.ipScoreV6");
  const locale = signal.localeRegion;
  const country = signal.ipCountry;
  const geoMismatch = !!(locale && country && locale !== country);
  if (geoMismatch) penalize(10, "qt.ipScoreGeo", { locale, country });
  if (signal.dnsLeak) penalize(5, "qt.ipScoreDns");
  if (signal.proxy === false && signal.hosting === false) reasons.push({ kind: "good", key: "qt.ipGoodClean" });
  if (signal.ipv6 === false) reasons.push({ kind: "good", key: "qt.ipGoodV4" });
  if (!geoMismatch && locale && country) reasons.push({ kind: "good", key: "qt.ipGoodGeo" });
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

export type HistoryRow = { t: number; ip: string; score: number; flags: string[] };
const HISTORY_KEY = "cic_history";
const HISTORY_LIMIT = 50;

export function loadHistory(): HistoryRow[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const rows = raw ? (JSON.parse(raw) as HistoryRow[]) : [];
    return Array.isArray(rows) ? rows.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveHistory(rows: HistoryRow[]): HistoryRow[] {
  const capped = rows.slice(0, HISTORY_LIMIT);
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(capped)); } catch { /* 配额满即弃 */ }
  return capped;
}

export function traceOf(report: IpCheckReport | null): IpCheckTrace | null {
  return report?.claude ?? null;
}
