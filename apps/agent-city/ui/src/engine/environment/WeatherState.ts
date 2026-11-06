/** Deterministic weather facts, independent of rendering and vehicles. */
import { hashSeed } from "../../cityModel";

export type WeatherKind = "clear" | "overcast" | "rain";
export type WeatherState = { kind: WeatherKind; intensity: number; rainbow: number; overcast: number };

const RAIN_THRESHOLD = 0.82;
const OVERCAST_THRESHOLD = 0.62;

/** 某时刻的天气。ms 为回放游标或真实时钟。 */
export function weatherAt(ms: number, utcOffsetMinutes = -new Date(ms).getTimezoneOffset()): WeatherState {
  // 按本地时间切日：曾用 ms/86_400_000（UTC 日界），天空用本地小时——北京时间每天 8 点天气突变。
  if (!Number.isFinite(ms) || !Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 14 * 60) throw new Error("invalid-weather-time");
  const local = ms + utcOffsetMinutes * 60_000;
  const dayIndex = Math.floor(local / 86_400_000);
  const hour = ((local / 3_600_000) % 24 + 24) % 24;
  // 顺序日期先过一次 Knuth 混淆再入哈希：FNV 对「末位数字 +1」的字符串雪崩
  // 不足，直接哈希会让相邻日期的天气强相关（实测连出十几天的同种天气）。
  const roll = hashSeed(`weather:${(Math.imul(dayIndex, 2654435761) ^ 0x9e3779b9) >>> 0}`);
  const kind: WeatherKind = roll < OVERCAST_THRESHOLD ? "clear" : roll < RAIN_THRESHOLD ? "overcast" : "rain";
  // 首尾 1.5 小时包络：跨日不跳变，日内恒定。
  const envelope = Math.max(0, Math.min(1, Math.min(hour / 1.5, (24 - hour) / 1.5)));
  // 阵雨：原版 DayNightCycle.getRainWeight——两条频率比无理的慢正弦加权，过 0.50–0.58 的 smoothstep。
  // 原版按秒（周期 ~2 分钟，游戏时间）；这里按小时（周期 ~1.7h / 3.9h），相位按当天播种，回放可复现。
  // 雨天下限 0.25：阴雨天的间隙仍飘着毛毛雨，不会突然变成晴天里的雨天。
  const seed = hashSeed(`rainphase:${dayIndex}`) * 100;
  const a = Math.sin(hour * 3.7 + seed * 1.7) * 0.5 + 0.5;
  const b = Math.sin(hour * 1.6 + seed * 3.1) * 0.5 + 0.5;
  const raw = a * 0.65 + b * 0.35;
  const shower = Math.max(0, Math.min(1, (raw - 0.5) / 0.08));
  const showerWeight = 0.25 + 0.75 * shower * shower * (3 - 2 * shower);
  const intensity = kind === "clear" ? 0 : kind === "rain" ? envelope * showerWeight : envelope;
  const overcast = kind === "clear" ? 0 : envelope * (kind === "rain" ? 1 : 0.72);
  const yesterdayRained = hashSeed(`weather:${(Math.imul(dayIndex - 1, 2654435761) ^ 0x9e3779b9) >>> 0}`) >= RAIN_THRESHOLD;
  // 只在日出后（6:00–7:30 淡入）到上午（8:30–11:00 淡出）：曾只有 (11-hour)/2.5，凌晨 0–6 点整夜挂着彩虹。
  const sunrise = Math.max(0, Math.min(1, (hour - 6) / 1.5));
  const rainbow = yesterdayRained && hashSeed(`bow:${dayIndex}`) < 0.5 ? sunrise * Math.max(0, Math.min(1, (11 - hour) / 2.5)) : 0;
  return { kind, intensity, overcast, rainbow };
}

