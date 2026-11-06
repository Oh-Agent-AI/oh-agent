// 字符画场景：纯文本网格逐帧渲染，无素材、无网络、无遥测。
// 上一版把多边形光栅化成字符再压暗，缩小后只剩噪点；这里改为按网格手绘的
// 形状掩码，每个格子的字形和颜色都是作者定的，任何尺寸下都能认出轮廓。
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const scenes = [];

  // ── 啄木鸟：与 app 图标同一形象，朝右攀在日志树干上 ──
  // 形状由 tools/ascii-from-image.mjs 从生成图转码：先按颜色把每格归到部位，
  // 部位决定颜色；边缘格按填充偏向取 / \ ( ) _ ' 保持轮廓圆滑。
  // <generated:woodpecker>
  // 由 tools/ascii-from-image.mjs 从 tools/woodpecker-source.png 生成，勿手改；换图后重跑脚本。
  const WOODPECKER = {
    beakRow: 6,
    headRows: 10,
    glyphs: [
      "(_",
      " \\###______",
      "/_/#############___",
      " '###################_",
      "   \\###################\\",
      "    '###########==@ @###\\",
      "       '##=======@   @===========>",
      "         =====####@@@###==",
      "         \\#############",
      "           \\########+++",
      "            ###%%%#+++++\\",
      "            %%%%%%%%++++++",
      "          /%%%%%%%%%%++++++",
      "         /%%%%%%%%%%%%++++++    __",
      "         %%%%%%%%%%%%%++++++   /\\_",
      "         %%%%%%%%%%%%%++++++  _\\/",
      "         %%%%%%%%%%%%+++++++\\\\/\\\\",
      "         (%%%%%%%%%%%+++++++'",
      "          %%%%%%%%%%%++++++",
      "          \\%%%%%%%%%++++++)",
      "           \\%%%%%%%+++++++\\_    _/",
      "            %%%%%%%++++++'''\\\\_\\\\_",
      "             %%%%%\\\\++++)     (\\",
      "              %%%%%\\\\\\++)      '",
      "               \\%%%\\\\\\\\\\\\",
      "                \\/ \\\\\\\\\\\\\\\\",
      "                     \\\\\\\\\\\\\\",
      "                      \\\\\\\\\\\\\\",
      "                       \\\\\\\\\\\\",
      "                        \\\\)\\\\\\",
      "                         \\\\  \\\\",
      "                          \\)   \\",
      "                           \\",
    ],
    classes: [
      "cc",
      " cccccccccc",
      "ccccccccccccccccccc",
      " ccccccccccccccccccccc",
      "   ccccccccHHHHHHHHHHHcc",
      "    ccccccHHHHHHssEPEHHHH",
      "       ccHsssssssEPPPEssbbbbbbbbbb",
      "         sssssHHHHEEEHHHbb",
      "         HHHHHHHHHHHHHH",
      "           HHHHHHHHHlll",
      "            HHHwwwHllllll",
      "            wwwwwwwwllllll",
      "          wwwwwwwwwwwllllll",
      "         wwwwwwwwwwwwwllllll    tt",
      "         wwwwwwwwwwwwwllllll   ttt",
      "         wwwwwwwwwwwwwllllll  ttt",
      "         wwwwwwwwwwwwlllllllttttt",
      "         wwwwwwwwwwwwlllllllt",
      "          wwwwwwwwwwwllllll",
      "          wwwwwwwwwwlllllll",
      "           wwwwwwwwllllllltt    tt",
      "            wwwwwwwllllllttttttttt",
      "             wwwwwttlllll     tt",
      "              wwwwwtttlll      t",
      "               wwwwtttttt",
      "                ww wttttttt",
      "                     ttttttt",
      "                      ttttttt",
      "                       tttttt",
      "                        tttttt",
      "                         tt  tt",
      "                          tt   t",
      "                           t",
    ],
  };
  // </generated:woodpecker>
  // 部位 → 颜色类。深绿（眼部色带 s、翅膀 w）在暗底上按原色太暗，统一提亮一档。
  const PART_COLOR = { c: 'k3', H: 'k2', s: 'kd', E: 'kw', P: '', b: 'kc', w: 'kd', l: 'kl', t: 'kt' };
  const LOG = [
    ['09:41:02', 'read', 'notes.md', 'ok'],
    ['09:41:03', 'plan', 'step 1/4', 'ok'],
    ['09:41:05', 'search', '"Q3 plan"', 'ok'],
    ['09:41:08', 'fetch', 'report.api', 'ERR'],
    ['09:41:16', 'fetch', 'report.api', 'ERR'],
    ['09:41:32', 'fetch', 'report.api', 'ERR'],
    ['09:42:10', 'fetch', 'report.api', 'ok'],
    ['09:42:12', 'read', 'q3.xlsx', 'ok'],
    ['09:42:14', 'tokens', '+1.2M', '94%'],
    ['09:42:20', 'write', 'summary.md', 'ok'],
    ['09:42:31', 'edit', 'summary.md', 'ok'],
    ['09:42:40', 'shell', 'pytest', 'ERR'],
    ['09:42:58', 'shell', 'pytest', 'ok'],
    ['09:43:02', 'tokens', '+0.4M', '97%'],
    ['09:43:05', 'done', 'turn 12', 'ok'],
  ];
  // 鸟占树干左侧的 TRUNK 列；日志 31 字 + 两侧树皮 = TRUNK + 33 列
  const BIRD_TOP = 1;
  const TRUNK = Math.max(...WOODPECKER.glyphs.map(g => g.length));
  const W = TRUNK + 33, W_COMPACT = TRUNK + 19;
  const H = WOODPECKER.glyphs.length + BIRD_TOP;
  const BEAK_ROW = WOODPECKER.beakRow + BIRD_TOP;
  const HEAD_ROWS = WOODPECKER.headRows; // 这些行随啄击平移，身体不动

  function woodpecker(el) {
    const counters = {
      scanned: el.closest('figure')?.querySelector('[data-count="scanned"]'),
      flagged: el.closest('figure')?.querySelector('[data-count="flagged"]'),
    };
    const s = { offset: 0, flagged: new Set(), scanned: 0, peck: 0, sparks: 0, lastStep: 0, blinkAt: 2.5 };
    // 起点：让第一条失败行正好停在喙前（鸟的尺寸由生成图决定，不能写死偏移）
    while (!line(s.offset + BEAK_ROW).err) s.offset += 1;
    // 静态帧：喙以上（已检查过）的失败行全部标记，喙以下的还没轮到。
    // 暂停时也能看懂画面在说什么：鸟经过的地方，问题都被标出来了。
    for (let r = 0; r <= BEAK_ROW; r += 1) if (line(s.offset + r).err) s.flagged.add(s.offset + r);

    function line(abs) {
      const [time, verb, target, status] = LOG[((abs % LOG.length) + LOG.length) % LOG.length];
      return { time, verb, target, status, err: status === 'ERR', abs };
    }
    let total = s.flagged.size;
    s.scanned = s.offset + BEAK_ROW + 1;
    if (counters.scanned) counters.scanned.textContent = String(s.scanned).padStart(4, '0');
    if (counters.flagged) counters.flagged.textContent = String(total).padStart(2, '0');
    function step(t) {
      s.offset += 1;
      s.scanned += 1;
      const at = line(s.offset + BEAK_ROW);
      if (at.err && !s.flagged.has(at.abs)) { s.flagged.add(at.abs); s.peck = t; total += 1; }
      for (const abs of s.flagged) if (abs < s.offset) s.flagged.delete(abs); // 滚出顶部才忘掉
      if (counters.scanned) counters.scanned.textContent = String(s.scanned % 10000).padStart(4, '0');
      if (counters.flagged) counters.flagged.textContent = String(total % 100).padStart(2, '0');
    }

    // 窄屏去掉「目标」列：全宽网格在手机上只剩 6px 字号，读不出日志；紧凑版能到 9px 左右
    let compact = false, width = W;
    const api = { el, cols: W, render, setCompact(value) {
      if (value === compact) return false;
      compact = value; width = compact ? W_COMPACT : W; api.cols = width;
      return true;
    } };

    function render(t, animate) {
      if (animate) {
        if (t - s.lastStep > 0.62) { s.lastStep = t; step(t); }
        if (t > s.blinkAt + 0.16) s.blinkAt = t + 3 + (s.offset % 3);
      }
      const pecking = animate && t - s.peck < 0.22;
      const impact = animate && t - s.peck < 0.5;
      const blinking = animate && t >= s.blinkAt && t < s.blinkAt + 0.16;
      const grid = Array.from({ length: H }, () => Array.from({ length: width }, () => [' ', '']));
      const put = (x, y, ch, cls) => { if (x >= 0 && x < width && y >= 0 && y < H) grid[y][x] = [ch, cls]; };

      // 树干：左缘是树皮纹理，内部是逐行上移的会话日志
      for (let y = 0; y < H; y += 1) {
        const bark = ((y + s.offset) * 7) % 5;
        put(TRUNK, y, bark === 0 ? ')' : bark === 3 ? '(' : '|', 'k1');
        put(width - 1, y, '|', 'k0');
        const l = line(s.offset + y);
        const flagged = s.flagged.has(l.abs);
        const text = compact
          ? `${flagged ? '!' : ' '}${l.time.slice(3)} ${l.verb.padEnd(6)} ${l.status.padStart(3)}`
          : `${flagged ? '!' : ' '}${l.time} ${l.verb.padEnd(6)} ${l.target.padEnd(11)}${l.status.padStart(3)}`;
        const [timeEnd, verbEnd, statusAt] = compact ? [6, 13, 14] : [9, 16, 28];
        const hit = flagged && y === BEAK_ROW && impact;
        [...text].forEach((ch, i) => {
          let cls = i < timeEnd ? 'k0' : i < verbEnd ? 'k1' : 'k2';
          if (i === 0) cls = 'ka';
          if (i >= statusAt) cls = l.err ? (flagged ? 'ka' : 'kr') : 'k1';
          if (flagged && i > 0 && i < statusAt) cls = 'ka';
          if (hit) cls = 'kh';
          put(TRUNK + 1 + i, y, ch, cls);
        });
      }

      // 啄木鸟
      WOODPECKER.glyphs.forEach((row, r) => {
        const dx = r < HEAD_ROWS && pecking ? 1 : 0;
        const parts = WOODPECKER.classes[r];
        [...row].forEach((glyph, c) => {
          const part = parts[c];
          if (!part || part === ' ') return;
          let ch = glyph;
          if (part === 'E' && blinking) ch = '-';
          // 填充格偶尔换一个近似字形，让羽毛有细微的呼吸感；边缘格不动，轮廓保持稳定
          if ((ch === '#' || ch === '%') && ((c * 31 + r * 17 + Math.floor(t * 1.5)) % 23 === 0)) ch = ch === '#' ? '%' : '#';
          if (ch !== ' ') put(c + dx, r + BIRD_TOP, ch, PART_COLOR[part]);
        });
      });

      // 啄击的碎屑
      if (impact) {
        const k = Math.floor((t - s.peck) * 10);
        [[-1, -1, '\''], [1, -1, '`'], [-1, 1, ','], [1, 1, '.'], [0, -2, '*'], [0, 2, '*']].forEach(([dx, dy, ch], i) => {
          if ((i + k) % 2 === 0) put(TRUNK - 1 + dx * (1 + (k > 2)), BEAK_ROW + dy, ch, 'ka');
        });
      }
      return grid;
    }
    return api;
  }

  // ── 工作收据：逐行打印，打完停留，再换一张 ──
  const RECEIPTS = [
    ['research-q3', '128', '3', '18.6 M', '90 %', ((window.__avLandingLang || {}).lang === 'zh' ? '¥ 4.10' : '$ 0.60'), 'estimate'],
    ['refactor-auth', '342', '1', '42.3 M', '96 %', '—', 'subscription'],
  ];
  function receipt(el) {
    const cols = 38;
    function lines(r) {
      const [name, events, fails, tokens, cache, cost, basis] = r;
      const row = (k, v, mark = ' ') => `│ ${k.padEnd(16)}${v.padStart(15)} ${mark}  │`;
      return [
        ['╭────────────────────────────────────╮', 'k1'],
        ['│      AGENT VITALS · WORK RECEIPT   │', 'k3'],
        [`│ session ${name.padEnd(27)}│`, 'k2'],
        ['│ ─────────────────────────────────  │', 'k0'],
        [row('events', events), 'k2'],
        [row('tool failures', fails, '!'), 'ka'],
        [row('tokens', tokens), 'k2'],
        [row('cache read', cache), 'k2'],
        [row('cost', cost, '~'), 'kw'],
        [row('billing basis', basis), 'k2'],
        ['│ ─────────────────────────────────  │', 'k0'],
        ['│ unknown ≠ zero                     │', 'k1'],
        ['│ estimate ≠ bill                    │', 'k1'],
        ['│ analyzed on this Mac               │', 'k1'],
        ['╰╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╮╭╯', 'k1'],
      ];
    }
    function render(t, animate) {
      const cycle = 9;
      const which = animate ? Math.floor(t / cycle) % RECEIPTS.length : 0;
      const local = animate ? t % cycle : cycle;
      const all = lines(RECEIPTS[which]);
      const shown = Math.min(all.length, Math.floor(local / 0.16));
      return all.map(([text, cls], i) => {
        const chars = [...text.padEnd(cols)].slice(0, cols);
        if (i >= shown) return chars.map(() => [' ', '']);
        return chars.map((ch, x) => [ch, /[│╭╮╰╯─]/.test(ch) && (x === 0 || x >= cols - 3 || i === 0 || i === all.length - 1) ? 'k1' : cls]);
      });
    }
    return { el, cols, render };
  }

  const factories = { woodpecker, receipt };

  document.querySelectorAll('[data-ascii]').forEach(el => {
    const make = factories[el.dataset.ascii];
    if (!make) return;
    const scene = make(el); // 不展开复制：setCompact 要能改到同一个对象的 cols
    scene.visible = false;
    scenes.push(scene);
    // 字号跟随容器宽度，保证网格永远正好铺满、不换行、不横向滚动
    // 字宽实测而非假定 0.6em：回退字体不同，估错一点就会把右侧裁掉
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(50);
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px;white-space:pre';
    el.append(probe);
    const ratio = probe.getBoundingClientRect().width / 5000 || 0.6;
    probe.remove();
    const fit = () => {
      const cs = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (scene.setCompact?.(inner < 440)) draw(scene, 0, false);
      el.style.fontSize = `${Math.min(15, Math.floor((inner / (scene.cols * ratio)) * 10) / 10)}px`;
    };
    new ResizeObserver(fit).observe(el);
    fit();
    draw(scene, 0, false);
  });

  function draw(scene, t, animate) {
    const grid = scene.render(t, animate);
    let html = '';
    for (const row of grid) {
      let run = '', cls = null;
      const flush = () => { if (run) html += cls ? `<span class="${cls}">${run}</span>` : run; run = ''; };
      for (const [ch, c] of row) {
        const safe = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
        if (c !== cls) { flush(); cls = c; }
        run += safe;
      }
      flush();
      html += '\n';
    }
    scene.el.innerHTML = html;
  }

  let frame = 0, start = 0, last = 0;
  const paused = () => reduced.matches || document.hidden || document.body.classList.contains('motion-paused');
  function tick(now) {
    frame = 0;
    if (paused() || !scenes.some(s => s.visible)) return;
    if (now - last > 80) {
      last = now;
      const t = (now - start) / 1000;
      scenes.filter(s => s.visible).forEach(s => draw(s, t, true));
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (paused()) { scenes.forEach(s => draw(s, 0, false)); return; }
    if (!start) start = performance.now();
    if (scenes.some(s => s.visible)) frame = requestAnimationFrame(tick);
  }
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { const s = scenes.find(x => x.el === e.target); if (s) s.visible = e.isIntersecting; });
    sync();
  }, { threshold: 0.05 });
  scenes.forEach(s => io.observe(s.el));
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
})();
