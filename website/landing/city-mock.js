// Agent City 落地页 mock：单个 canvas、零依赖、零素材、零网络。
// 视觉语法取自应用内 CityEngine（Miami 主题）：紫粉桃三段天空、五宿主粉彩
// 楼色、亮窗=活动、吊车=在建、昼夜光照、雨与雨后彩虹、缓慢运镜。
// 数据为示例；确定性种子驱动，暂停/减弱动效时渲染完整静帧。
(() => {
  const canvas = document.getElementById('city-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const DAY = 40; // 一整个昼夜周期（秒）

  // ── 调色板：镜像 cityTheme.ts Miami 主题 ──
  const HOSTS = [
    { wall: '#ffd2c4', roof: '#ff6f9f', tag: 'cc' },   // claude-code
    { wall: '#c4f4f6', roof: '#3cc3d2', tag: 'dx' },   // codex
    { wall: '#c8f7e0', roof: '#45d0a2', tag: 'ds' },   // dsh
    { wall: '#e3d2ff', roof: '#9a6cf5', tag: 'zc' },   // zcode
    { wall: '#ffc9ea', roof: '#ea58ac', tag: 'mx' },   // minimax
  ];
  const SKY = {
    day:    { top: '#3f7fb8', mid: '#9fd0e8', horizon: '#eaf4ec' },
    sunset: { top: '#2b1f6b', mid: '#e0529c', horizon: '#ffb072' }, // 应用内主题原色
    night:  { top: '#0a0d24', mid: '#141a3c', horizon: '#232a55' },
  };
  const GROUND = '#2a3a35', ROAD = '#1d2a26', PARK = '#2f5c46';

  // ── 确定性种子（暂停/重放帧稳定；不许 Math.random）──
  let seed = 20261002;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // ── 城市模型：5×5 街区，一街区一楼 + 一公园 + 一在建 ──
  const N = 5, blocks = [];
  for (let by = 0; by < N; by += 1) {
    for (let bx = 0; bx < N; bx += 1) {
      const kind = (bx === 1 && by === 3) ? 'park' : (bx === 3 && by === 1) ? 'crane' : 'tower';
      const host = HOSTS[Math.floor(rnd() * HOSTS.length)];
      blocks.push({
        bx, by, kind, host,
        floors: kind === 'tower' ? 3 + Math.floor(rnd() * 8) : 1,
        neon: rnd() < 0.45,          // 夜间屋顶霓虹（bloom 的 2D 回声）
        windows: {},                 // "floor,face,col" -> 点亮；昼夜阈值翻转
      });
    }
  }
  const cars = Array.from({ length: 7 }, (_, i) => ({
    lane: i % 4, offset: rnd(), speed: 0.028 + rnd() * 0.02, hue: HOSTS[i % HOSTS.length].roof,
  }));
  const stars = Array.from({ length: 46 }, () => ({ x: rnd(), y: rnd() * 0.6, tw: rnd() * 6 }));
  const clouds = Array.from({ length: 3 }, () => ({ x: rnd(), y: 0.08 + rnd() * 0.18, w: 0.16 + rnd() * 0.14 }));

  // ── 昼夜相位：0..1 → 光照 / 天空 / 亮窗密度 / 雨 ──
  // dawn .0-.12 → day .12-.42 → sunset .42-.58 → rain .58-.72（雨后短彩虹）→ night .72-1
  function phase(p) {
    const mix = (a, b, k) => {
      const c = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16) + (parseInt(b.slice(i, i + 2), 16) - parseInt(a.slice(i, i + 2), 16)) * k);
      return `rgb(${c.map(v => Math.round(v)).join(',')})`;
    };
    let from, to, k;
    if (p < 0.12)      { from = SKY.night;  to = SKY.day;    k = p / 0.12; }
    else if (p < 0.42) { from = SKY.day;    to = SKY.day;    k = 0; }
    else if (p < 0.58) { from = SKY.day;    to = SKY.sunset; k = (p - 0.42) / 0.16; }
    else if (p < 0.72) { from = SKY.sunset; to = SKY.night;  k = 0.35; } // 雨：压暗的天空
    else               { from = SKY.sunset; to = SKY.night;  k = (p - 0.72) / 0.28; }
    return {
      sky: { top: mix(from.top, to.top, k), mid: mix(from.mid, to.mid, k), horizon: mix(from.horizon, to.horizon, k) },
      light: p < 0.12 ? 0.45 + 0.55 * (p / 0.12)
           : p < 0.42 ? 1
           : p < 0.58 ? 1 - 0.45 * ((p - 0.42) / 0.16)
           : p < 0.72 ? 0.45 - 0.1 * ((p - 0.58) / 0.14)
           : Math.max(0.18, 0.35 - 0.17 * ((p - 0.72) / 0.28)),
      litWindows: p < 0.2 ? 0.55 : p < 0.45 ? 0.12 : p < 0.6 ? 0.35 : 0.62,
      raining: p >= 0.58 && p < 0.72,
      rainbow: p >= 0.70 && p < 0.78,
      night: p >= 0.62,
    };
  }

  // ── 等距投影 ──
  let TW = 30, TH = 15; // tile 半宽半高
  const iso = (gx, gy) => [(gx - gy) * TW, (gx + gy) * TH];

  function litAt(b, floor, face, col, t, litW) {
    const key = `${floor},${face},${col}`;
    // 窗的亮灭按 4 秒一档确定性翻转；密度随昼夜（夜间更亮）
    const h = ((b.bx * 73 + b.by * 131 + floor * 17 + face * 43 + col * 291 + Math.floor(t / 4) * 101) % 97) / 97;
    return h < litW;
  }

  function drawBuilding(b, height, ph, t) {
    const [x, y] = iso(b.bx * 2.2 + 0.6, b.by * 2.2 + 0.6);
    const w = TW * 1.5, floorH = 9;
    const shade = (c, k) => c; // 立面明暗交给 face 因子
    const wall = b.host.wall, roof = b.host.roof;
    // 夜间整体压暗 + 暖化：把墙色向夜色插值
    const dark = (c, k) => {
      const n = parseInt(c.slice(1), 16);
      const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(v * k + 26 * (1 - k)));
      return `rgb(${r},${g},${bl})`;
    };
    const wallK = 0.45 + 0.55 * ph.light;
    const H0 = y, top = y - height * floorH;
    // 顶面
    ctx.fillStyle = dark(roof, wallK + 0.15);
    ctx.beginPath();
    ctx.moveTo(x, top - TH * 0.5); ctx.lineTo(x + w, top); ctx.lineTo(x, top + TH * 0.5); ctx.lineTo(x - w, top); ctx.closePath();
    ctx.fill();
    // 左面（更暗）与右面
    for (const side of [-1, 1]) {
      ctx.fillStyle = dark(wall, wallK * (side < 0 ? 0.78 : 1));
      ctx.beginPath();
      ctx.moveTo(x + side * w, top); ctx.lineTo(x + side * w, y); ctx.lineTo(x, y + TH * 0.5); ctx.lineTo(x, top + TH * 0.5); ctx.closePath();
      ctx.fill();
      // 窗：每层 3 格
      const cols = side < 0 ? ['#', '#', '#'] : ['#', '#', '#'];
      for (let f = 0; f < height - 1; f += 1) {
        for (let c = 1; c <= 3; c += 1) {
          const lit = litAt(b, f, side < 0 ? 0 : 1, c, t, ph.litWindows);
          const wx = x + side * w * (0.2 + 0.24 * (c - 1) + 0.12);
          const wy = top + (f + 1) * floorH - 3 + (c - 1.5) * 0; // 沿面斜向近似：直接竖排
          const px = x + side * (w * (0.18 + 0.26 * (c - 1))), py = top + TH * 0.25 + (f + 0.6) * floorH * 0.86;
          ctx.fillStyle = lit ? '#ffd27a' : 'rgba(10,14,20,0.42)';
          ctx.fillRect(px - 2, py - 2.5, 4, 5);
        }
      }
    }
    // 夜间屋顶霓虹（ Miami bloom 的平面回声）
    if (b.neon && ph.night) {
      ctx.strokeStyle = b.host.roof;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(x, top - TH * 0.5); ctx.lineTo(x + w, top); ctx.lineTo(x, top + TH * 0.5); ctx.lineTo(x - w, top); ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawCrane(b, t, ph) {
    const [x, y] = iso(b.bx * 2.2 + 0.6, b.by * 2.2 + 0.6);
    const wallK = 0.45 + 0.55 * ph.light;
    // 在建楼层（脚手架色）
    ctx.strokeStyle = `rgba(255,178,110,${0.5 + 0.4 * wallK})`;
    ctx.strokeRect(x - TW * 0.9, y - 26, TW * 1.8, 26);
    for (let i = 1; i < 3; i += 1) {
      ctx.beginPath(); ctx.moveTo(x - TW * 0.9 + i * TW * 0.6, y - 26); ctx.lineTo(x - TW * 0.9 + i * TW * 0.6, y); ctx.stroke();
    }
    // 吊车：塔身 + 每 3 秒换向的臂 + 吊钩
    const mastTop = y - 64;
    ctx.strokeStyle = '#ffb26e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 26); ctx.lineTo(x, mastTop); ctx.stroke();
    const dir = Math.floor(t / 3) % 2 === 0 ? 1 : -1;
    ctx.beginPath(); ctx.moveTo(x - dir * 26, mastTop - 3); ctx.lineTo(x, mastTop); ctx.lineTo(x + dir * 30, mastTop - 6); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + dir * 24, mastTop - 5); ctx.lineTo(x + dir * 24, mastTop + 12); ctx.stroke();
    ctx.fillStyle = '#ff8a5c';
    ctx.fillRect(x + dir * 24 - 3, mastTop + 12, 6, 5);
  }

  function drawPark(b, ph) {
    const [x, y] = iso(b.bx * 2.2 + 0.6, b.by * 2.2 + 0.6);
    const k = 0.45 + 0.55 * ph.light;
    ctx.fillStyle = `rgb(${Math.round(47 * k + 14)},${Math.round(92 * k + 20)},${Math.round(70 * k + 22)})`;
    ctx.beginPath();
    ctx.moveTo(x, y - TH * 0.9); ctx.lineTo(x + TW * 1.4, y); ctx.lineTo(x, y + TH * 0.9); ctx.lineTo(x - TW * 1.4, y); ctx.closePath();
    ctx.fill();
    // 棕榈（Miami）：弯干 + 扇叶
    for (const [dx, dy, s] of [[-0.5, 0.1, 1], [0.45, -0.15, 0.8], [0, 0.4, 0.7]]) {
      const px = x + dx * TW, py = y + dy * TH;
      ctx.strokeStyle = '#8a6a4a'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + 3, py - 9 * s, px + 5, py - 15 * s); ctx.stroke();
      ctx.strokeStyle = '#3fa878'; ctx.lineWidth = 1.2;
      for (let a = -2.4; a <= -0.7; a += 0.42) {
        ctx.beginPath(); ctx.moveTo(px + 5, py - 15 * s);
        ctx.quadraticCurveTo(px + 5 + Math.cos(a) * 7 * s, py - 15 * s + Math.sin(a) * 5 * s, px + 5 + Math.cos(a) * 11 * s, py - 13 * s + Math.sin(a) * 8 * s);
        ctx.stroke();
      }
    }
  }

  let litCounterEl = null, buildingsCounterEl = null;
  let visible = false, frame = 0, start = 0, lastCounter = 0;

  function render(t) {
    const W = canvas.width / (window.devicePixelRatio > 2 ? 2 : window.devicePixelRatio || 1);
    const dpr = canvas.width / W;
    const H = canvas.height / dpr;
    const ph = phase(((t / DAY) + 0.34) % 1); // 从黄昏前开始：第一眼就是 Miami 主色
    const introK = Math.min(1, t / 5);         // 5 秒生长进场

    // 缓慢运镜：正弦漂移 + 呼吸缩放（cinematic 的平面回声）
    const driftX = Math.sin(t * 0.1) * 10, driftY = Math.cos(t * 0.13) * 5;
    const zoom = 1 + 0.015 * Math.sin(t * 0.07);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 天空三段渐变（应用内 skyTop/skyMid/skyHorizon）
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, ph.sky.top); grad.addColorStop(0.55, ph.sky.mid); grad.addColorStop(1, ph.sky.horizon);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 日/月 + 星 + 云
    const p = ((t / DAY) + 0.34) % 1;
    if (ph.night || p < 0.12) {
      for (const s of stars) {
        ctx.globalAlpha = 0.35 + 0.5 * Math.abs(Math.sin(t * 0.7 + s.tw));
        ctx.fillStyle = '#e8f2ff';
        ctx.fillRect(s.x * W, s.y * H, 1.5, 1.5);
      }
      ctx.globalAlpha = 1;
    }
    const sunX = W * (0.18 + 0.64 * p), sunY = H * (0.16 + 0.42 * Math.sin(Math.PI * Math.min(1, Math.max(0, (p - 0.05) / 0.55))));
    ctx.fillStyle = ph.night ? '#f3f0d8' : '#ffd98c';
    ctx.beginPath(); ctx.arc(sunX, sunY, ph.night ? 9 : 13, 0, Math.PI * 2); ctx.fill();
    if (!ph.night && !ph.raining) {
      ctx.globalAlpha = 0.16; ctx.fillStyle = '#fff2c8';
      ctx.beginPath(); ctx.arc(sunX, sunY, 26, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
    if (!ph.raining) for (const c of clouds) {
      const cx = ((c.x + t * 0.006) % 1.3 - 0.15) * W;
      ctx.globalAlpha = 0.2; ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(cx, c.y * H, c.w * W, 7, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + c.w * W * 0.4, c.y * H + 3, c.w * W * 0.6, 5, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.globalAlpha = 1;
    }

    // 地台（等距菱形）
    ctx.save();
    ctx.translate(W / 2 + driftX, H * 0.34 + driftY);
    ctx.scale(zoom, zoom);
    const span = N * 2.2 + 1;
    ctx.fillStyle = GROUND;
    ctx.beginPath();
    const corners = [iso(-0.5, -0.5), iso(span, -0.5), iso(span, span), iso(-0.5, span)];
    ctx.moveTo(...corners[0]);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(...corners[i]);
    ctx.closePath(); ctx.fill();

    // 道路网（街区之间）+ 车流
    ctx.strokeStyle = ROAD; ctx.lineWidth = 14; ctx.lineCap = 'round';
    for (let i = 0; i <= N; i += 1) {
      const pos = i * 2.2 - 0.25;
      ctx.beginPath(); ctx.moveTo(...iso(pos, -0.3)); ctx.lineTo(...iso(pos, span)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(...iso(-0.3, pos)); ctx.lineTo(...iso(span, pos)); ctx.stroke();
    }
    for (const car of cars) {
      const s = (car.offset + t * car.speed) % 1;
      let a, b;
      if (car.lane === 0) { a = [0.4 + s * (span - 0.8), -0.25]; b = a[0]; } // 东西向
      else if (car.lane === 1) { a = [-0.25, 0.4 + s * (span - 0.8)]; }
      else if (car.lane === 2) { a = [0.4 + s * (span - 0.8), span - 0.25]; }
      else { a = [span - 0.25, 0.4 + s * (span - 0.8)]; }
      const [cx, cy] = car.lane % 2 === 0 ? iso(a[0], a[1]) : iso(a[1], a[0]);
      ctx.fillStyle = car.hue;
      ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.fill();
      if (ph.night) { ctx.globalAlpha = 0.5; ctx.fillStyle = '#ffe9b0'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
    }

    // 楼宇（画家算法：按 gx+gy 排序）+ 生长进场
    let lit = 0;
    const sorted = [...blocks].sort((m, n) => (m.bx + m.by) - (n.bx + n.by));
    for (const b of sorted) {
      if (b.kind === 'park') { drawPark(b, ph); continue; }
      if (b.kind === 'crane') { drawCrane(b, t, ph); continue; }
      const delay = (b.bx + b.by) * 0.18;
      const grow = Math.max(0, Math.min(1, (t - delay) / 2.2));
      const height = Math.max(1, Math.round(b.floors * grow));
      if (height < 1) continue;
      drawBuilding(b, height, ph, t);
    }
    ctx.restore();

    // 雨（weather 的平面回声）与雨后彩虹
    if (ph.raining) {
      ctx.strokeStyle = 'rgba(190,215,255,0.30)'; ctx.lineWidth = 1;
      const drop = (t * 220) % 18;
      for (let i = 0; i < 70; i += 1) {
        const rx = ((i * 137.5) % 100) / 100 * W, ry = ((i * 89.3) % 100) / 100 * H;
        ctx.beginPath(); ctx.moveTo(rx, ry + drop); ctx.lineTo(rx - 3, ry + drop + 9); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(20,26,60,0.18)'; ctx.fillRect(0, 0, W, H);
    } else if (ph.rainbow) {
      const k = 1 - Math.abs(((t / DAY) % 1 - 0.74) / 0.04);
      ctx.globalAlpha = 0.16 * Math.max(0, k);
      const colors = ['#ff6f9f', '#ffb072', '#ffd98c', '#7fd6a4', '#3cc3d2', '#9a6cf5'];
      for (let i = 0; i < colors.length; i += 1) {
        ctx.strokeStyle = colors[i]; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(W * 0.78, H * 0.94, 120 - i * 4, Math.PI, Math.PI * 1.5); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 亮窗计数（限频更新 DOM）
    if (t - lastCounter > 0.5) {
      lastCounter = t;
      let count = 0;
      for (const b of blocks) {
        if (b.kind !== 'tower') continue;
        for (let f = 0; f < b.floors - 1; f += 1) for (let c = 1; c <= 3; c += 1) for (let face = 0; face < 2; face += 1) {
          if (litAt(b, f, face, c, t, ph.litWindows)) count += 1;
        }
      }
      if (litCounterEl) litCounterEl.textContent = String(count % 1000).padStart(3, '0');
      if (buildingsCounterEl) buildingsCounterEl.textContent = String(blocks.filter(b => b.kind === 'tower').length).padStart(4, '0');
    }
  }

  function fit() {
    // 量外壳（figure 的内容盒）而不是 canvas 自身——后者 width:100% 参与
    // 自身布局会自引用；再对荒谬宽度设防（display:none 期间为 0/上限值）。
    const host = canvas.parentElement;
    const w = Math.max(200, Math.min(1600, host.clientWidth - 2));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * 0.625 * dpr); // 16:10
  }
  new ResizeObserver(fit).observe(canvas);
  fit();

  buildingsCounterEl = canvas.closest('figure')?.querySelector('[data-count="city-buildings"]') || null;
  litCounterEl = canvas.closest('figure')?.querySelector('[data-count="city-lit"]') || null;

  const paused = () => reduced.matches || document.hidden || document.body.classList.contains('motion-paused');
  function tick(now) {
    frame = 0;
    if (paused() || !visible) return;
    const t = (now - start) / 1000;
    render(t);
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (paused()) { render(14.6); return; } // 静帧：长成后的黄昏时刻
    if (!start) start = performance.now();
    if (visible) frame = requestAnimationFrame(tick);
  }
  new IntersectionObserver(entries => {
    entries.forEach(e => { visible = e.isIntersecting; });
    sync();
  }, { threshold: 0.05 }).observe(canvas);
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
})();
