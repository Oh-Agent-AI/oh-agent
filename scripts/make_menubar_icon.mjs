// 生成菜单栏应用的 app icon（1024×1024 PNG，纯 Node，无依赖）。
//
// 设计：透明背景 + 深色圆角方块（slate-900）+ 三根成本柱（emerald-400）——
// "成本/预算"柱状图语义，正好是菜单栏展示的东西。`cargo tauri icon` 需要一份
// 1024×1024 源图，这里产源图，再由 tauri CLI 派生全部尺寸。
//
// PNG 用 zlib 手写（签名 + IHDR + IDAT + IEND），不引第三方包——与仓库
// "无第三方供应链"的纪律一致。

import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const RADIUS = 210;

// RGBA 各一个通道，0-255
const BG = [15, 23, 42, 255];     // #0f172a slate-900
const BAR = [52, 211, 153, 255];  // #34d399 emerald-400
const ZERO = [0, 0, 0, 0];

function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inBars(x, y) {
  // 三根柱子居中，宽 84，间距 52，高度 40%/62%/84%
  const barW = 84, gap = 52;
  const total = barW * 3 + gap * 2;
  const x0 = (SIZE - total) / 2;
  const base = 0.72 * SIZE; // 柱底统一，离底部留白
  const heights = [0.40, 0.62, 0.84].map((h) => h * 0.62 * SIZE);
  for (let i = 0; i < 3; i++) {
    const bx0 = x0 + i * (barW + gap);
    if (x >= bx0 && x < bx0 + barW) {
      const top = base - heights[i];
      if (y >= top && y < base) return true;
    }
  }
  return false;
}

// 逐行扫描。每行前置 filter byte 0，然后 RGBA。
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0;
  for (let x = 0; x < SIZE; x++) {
    const o = rowStart + 1 + x * 4;
    const c = inBars(x, y) ? BAR
      : inRoundedRect(x, y, RADIUS) ? BG : ZERO;
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = c[3];
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = new URL("../apps/desktop/src-tauri/icons/icon-source.png", import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${png.length} bytes)`);
