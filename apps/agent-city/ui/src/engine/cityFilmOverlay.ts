/**
 * 成片叠层：2.39:1 宽银幕黑边、字卡淡入淡出、右下角水印、片头片尾黑场。
 * 全部由 (秒数, 片长) 的纯函数决定——导出可复现，且与页面里 DOM 版的节奏一致
 * （city.css 的 city-cinema-card：18% 渐入、78% 渐出）。
 */

import type { CinematicCard } from "./cityCinematic";
import type { RenderContext2D } from "./renderCanvas";

/** 字卡文案由页面按当前语言提供（引擎不认识 i18n）。 */
export type FilmCardText = { eyebrow?: string; title: string; subtitle?: string };

export type FilmOverlayOptions = {
  width: number;
  height: number;
  seconds: number;
  durationSec: number;
  cards: CinematicCard[];
  describe: (card: CinematicCard) => FilmCardText | null;
  watermark: string;
  /** 宽银幕比例；竖版传 0 表示不加黑边。 */
  letterbox: number;
};

const FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** 字卡不透明度：卡片存续期内 18% 渐入、78% 起渐出（同 DOM 动画）。 */
export function cardAlpha(card: CinematicCard, seconds: number): number {
  const span = card.untilSec - card.atSec;
  if (span <= 0 || seconds < card.atSec || seconds > card.untilSec) return 0;
  const u = (seconds - card.atSec) / Math.min(span, card.kind === "finale" ? 1.6 : span);
  if (card.kind === "finale") return Math.min(1, u);
  if (u < 0.18) return u / 0.18;
  if (u > 0.78) return Math.max(0, 1 - (u - 0.78) / 0.22);
  return 1;
}

export function drawFilmOverlay(ctx: RenderContext2D, options: FilmOverlayOptions): void {
  const { width, height, seconds, durationSec } = options;
  // 黑边：片头 1.1s 内从中线滑开（同 DOM 的 city-cinema-bars）。
  if (options.letterbox > 0) {
    const full = Math.max(0, (height - width / options.letterbox) / 2);
    const bar = full * Math.min(1, seconds / 1.1);
    ctx.fillStyle = "#050507";
    ctx.fillRect(0, 0, width, bar);
    ctx.fillRect(0, height - bar, width, bar);
  }
  // 字卡（同一时刻最多一张）。
  const card = options.cards.find((item) => seconds >= item.atSec && seconds <= item.untilSec);
  const text = card ? options.describe(card) : null;
  if (card && text) {
    const alpha = cardAlpha(card, seconds);
    if (alpha > 0.001) {
      const unit = height / 1080;
      const centered = card.kind === "title" || card.kind === "finale";
      const x = centered ? width / 2 : width * 0.06;
      let y = centered ? height * 0.46 : height * 0.74;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = centered ? "center" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = 18 * unit;
      ctx.shadowOffsetY = 2 * unit;
      if (text.eyebrow) {
        ctx.font = `600 ${Math.round(14 * unit)}px ${FONT}`;
        ctx.globalAlpha = alpha * 0.78;
        ctx.fillText(text.eyebrow.toUpperCase().split("").join(String.fromCharCode(0x200a)), x, y);
        ctx.globalAlpha = alpha;
        y += 12 * unit;
      }
      const titleSize = Math.round((card.kind === "finale" ? 84 : 52) * unit);
      ctx.font = `700 ${titleSize}px ${FONT}`;
      y += titleSize;
      ctx.fillText(text.title, x, y);
      if (text.subtitle) {
        ctx.font = `400 ${Math.round(19 * unit)}px ${FONT}`;
        ctx.globalAlpha = alpha * 0.9;
        y += 36 * unit;
        ctx.fillText(text.subtitle, x, y);
      }
      ctx.restore();
    }
  }
  // 水印：片中常驻、右下，片头淡入。
  ctx.save();
  ctx.globalAlpha = 0.6 * Math.min(1, seconds / 1.5);
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 8;
  ctx.textAlign = "right";
  ctx.font = `600 ${Math.round(13 * (height / 1080))}px ${FONT}`;
  const markBottom = options.letterbox > 0 ? height - Math.max(0, (height - width / options.letterbox) / 2) - 18 * (height / 1080) : height - 24 * (height / 1080);
  ctx.fillText(options.watermark, width - 28 * (height / 1080), markBottom);
  ctx.restore();
  // 片头/片尾黑场各 0.6s。
  const fade = Math.max(Math.min(1, 1 - seconds / 0.6), Math.min(1, 1 - (durationSec - seconds) / 0.6));
  if (fade > 0.001) {
    ctx.fillStyle = `rgba(5,5,7,${Math.min(1, fade)})`;
    ctx.fillRect(0, 0, width, height);
  }
}
