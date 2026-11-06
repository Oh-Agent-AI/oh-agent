#!/usr/bin/env node
// 把扁平色块的啄木鸟图转成字符网格，写回 ../ascii-scenes.js 的生成区。
//
//   node tools/ascii-from-image.mjs [--cols 34] [--dry-run]
//
// 为什么不是通用的「亮度 → 字符」映射：那样出来的是一团明暗噪点（上一版插画的问题），
// 看不出部位。这里先按颜色把每一格归到部位（羽冠/头/眼/喙/翅/胸/尾），部位决定颜色和
// 填充字形；只在部分覆盖的边缘格按填充偏向选 / \ ( ) _ '，让轮廓保持圆滑。
// 源图要求见 README「Character scenes」：纯色背景、无渐变、颜色取自下面的调色板。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const SOURCE = opt('src', join(here, 'woodpecker-source.png'));
const COLS = Number(opt('cols', 34));
const DRY = args.includes('--dry-run');
// 字符格的高宽比 = 行高 / 字宽 = 1.22 / 0.602（与 styles.css .ascii 的 line-height 一致）
const CELL_ASPECT = 1.22 / 0.602;

// 实测色（生成图与提示词给的色值有偏差，按图里真实像素取）。null = 透明。
const PALETTE = [
  ['bg', [124, 123, 122], null],
  ['trunk', [63, 47, 38], null],
  ['crest', [174, 251, 222], 'c'],
  ['head', [125, 225, 187], 'H'],
  ['dark', [47, 105, 85], 'd'], // 眼部色带与翅膀同色，按位置再分
  ['eye', [248, 248, 248], 'E'],
  ['pupil', [0, 0, 0], 'P'],
  ['beak', [245, 235, 210], 'b'],
  ['chest', [214, 245, 230], 'l'],
  ['tail', [89, 188, 152], 't'],
];
// 细小但关键的部位：占格子一小部分也要保留，否则眼睛和喙会在缩小时消失
const MIN_SHARE = { P: 0.12, E: 0.2, b: 0.22 };
const PRIORITY = ['P', 'E', 'b'];

const im = readPng(SOURCE);
const nearest = (rgb) => {
  let best = null, dist = Infinity;
  for (const entry of PALETTE) {
    const d = (rgb[0] - entry[1][0]) ** 2 + (rgb[1] - entry[1][1]) ** 2 + (rgb[2] - entry[1][2]) ** 2;
    if (d < dist) { dist = d; best = entry; }
  }
  return best[2];
};

// 树干左缘：取中上部一行（避开爪子），从右往左找到第一个非树干像素
const trunkEdge = (() => {
  const y = Math.round(im.height * 0.12);
  for (let x = im.width - 1; x >= 0; x -= 1) if (nearest(im.get(x, y)) !== null || im.get(x, y)[0] > 100) return x + 1;
  throw new Error('trunk edge not found');
})();

// 鸟的包围盒（树干左侧的非透明像素）
let minX = Infinity, minY = Infinity, maxY = -1;
for (let y = 0; y < im.height; y += 2) {
  for (let x = 0; x < trunkEdge; x += 2) {
    if (nearest(im.get(x, y))) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
}
// 横向映射让最后一列正好止于树干左缘：喙尖因此贴着页面上的树干
const cellW = (trunkEdge - minX) / COLS;
const cellH = cellW * CELL_ASPECT;
const ROWS = Math.ceil((maxY - minY + 1) / cellH);

// 每格 8×12 采样，统计部位占比与填充质心
const SX = 8, SY = 12;
const classes = [], glyphs = [];
let firstWingRow = Infinity;
const cells = [];
for (let r = 0; r < ROWS; r += 1) {
  const row = [];
  for (let c = 0; c < COLS; c += 1) {
    const count = {}; let filled = 0, cx = 0, cy = 0;
    for (let j = 0; j < SY; j += 1) {
      for (let i = 0; i < SX; i += 1) {
        const x = Math.min(im.width - 1, Math.floor(minX + (c + (i + 0.5) / SX) * cellW));
        const y = Math.min(im.height - 1, Math.floor(minY + (r + (j + 0.5) / SY) * cellH));
        const k = x < trunkEdge ? nearest(im.get(x, y)) : null;
        if (!k) continue;
        count[k] = (count[k] || 0) + 1; filled += 1;
        cx += (i + 0.5) / SX - 0.5; cy += (j + 0.5) / SY - 0.5;
      }
    }
    const total = SX * SY;
    const share = filled / total;
    let cls = null;
    for (const p of PRIORITY) if ((count[p] || 0) / total >= MIN_SHARE[p]) { cls = p; break; }
    if (!cls && share >= 0.3) cls = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
    row.push({ cls, share, dx: filled ? cx / filled : 0, dy: filled ? cy / filled : 0 });
  }
  cells.push(row);
}
// 深绿：头部范围内是眼部色带，往下是翅膀。以「眼睛所在行 + 1」为界。
let eyeRow = -1;
cells.forEach((row, r) => { if (row.some(cell => cell.cls === 'E' || cell.cls === 'P')) eyeRow = Math.max(eyeRow, r); });
cells.forEach((row, r) => row.forEach(cell => {
  if (cell.cls === 'd') cell.cls = r <= eyeRow + 1 ? 's' : 'w';
  if (cell.cls === 'w') firstWingRow = Math.min(firstWingRow, r);
}));

const FILL = { c: '#', H: '#', s: '=', E: '@', P: ' ', b: '=', w: '%', l: '+', t: '\\' };
function edgeGlyph(cell) {
  const { dx, dy } = cell;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < 0.06 && ay < 0.06) return FILL[cell.cls];
  if (ay > ax * 2) return dy > 0 ? '_' : '\'';
  if (ax > ay * 2) return dx > 0 ? '(' : ')';
  return (dx > 0) === (dy > 0) ? '/' : '\\';
}
cells.forEach(row => {
  let mask = '', text = '';
  for (const cell of row) {
    if (!cell.cls) { mask += ' '; text += ' '; continue; }
    mask += cell.cls;
    const partial = cell.share < 0.72 && !['P', 'E', 'b'].includes(cell.cls);
    text += partial ? edgeGlyph(cell) : FILL[cell.cls];
  }
  classes.push(mask.replace(/\s+$/, ''));
  glyphs.push(text.replace(/\s+$/, ''));
});
// 去掉底部空行
while (glyphs.length && !glyphs[glyphs.length - 1].trim()) { glyphs.pop(); classes.pop(); }
// 喙尖所在行（最右侧的喙格），尖端固定用 '>'：缩小后喙尖只剩半格，形状会丢
let beakRow = 0, beakCol = -1;
classes.forEach((row, r) => { const c = row.lastIndexOf('b'); if (c > beakCol) { beakCol = c; beakRow = r; } });
if (beakCol >= 0) glyphs[beakRow] = glyphs[beakRow].slice(0, beakCol) + '>' + glyphs[beakRow].slice(beakCol + 1);
const ROWS_OUT = glyphs.length;

const art = { cols: COLS, rows: ROWS_OUT, beakRow, headRows: Number.isFinite(firstWingRow) ? firstWingRow : beakRow + 2, glyphs, classes };
console.log(glyphs.map((g, i) => `${String(i).padStart(2)} ${g}`).join('\n'));
console.log(`\ncols ${COLS} · rows ${ROWS_OUT} · beak row ${beakRow} · head rows ${art.headRows} · trunk edge x=${trunkEdge}`);

if (!DRY) {
  const target = join(here, '..', 'ascii-scenes.js');
  const src = readFileSync(target, 'utf8');
  const start = '  // <generated:woodpecker>', end = '  // </generated:woodpecker>';
  const a = src.indexOf(start), b = src.indexOf(end);
  if (a < 0 || b < 0) throw new Error('generated markers not found in ascii-scenes.js');
  const lines = (list) => list.map(l => `      ${JSON.stringify(l)},`).join('\n');
  const block = `${start}
  // 由 tools/ascii-from-image.mjs 从 tools/woodpecker-source.png 生成，勿手改；换图后重跑脚本。
  const WOODPECKER = {
    beakRow: ${art.beakRow},
    headRows: ${art.headRows},
    glyphs: [
${lines(glyphs)}
    ],
    classes: [
${lines(classes)}
    ],
  };
`;
  writeFileSync(target, src.slice(0, a) + block + src.slice(b));
  console.log(`wrote ${target}`);
}
