// 通用轨迹时间线几何 —— docs/TRAJECTORY_TIMELINE_SPEC.md §4/§5 的纯函数实现。
//
// 无 DOM、无构建链、无依赖：工作台直接 `<script src>`，node 的 verify 脚本直接
// `require`，dsh-client 经 `timeline-shared.cjs`（本文件的字节锁步副本；dsh-client
// 是 `"type": "module"`，`.cjs` 后缀让 esbuild 按 CommonJS 解析，否则 UMD 的
// `module.exports` 在 ESM 解析下是死代码、命名导入会变 void 0）`import`，
// codex_session.html 内联逐字节副本（>>> sv-timeline-geometry）。这里是「几何只
// 写一份」的那一份——比例尺算错了不报错、只有人眼看出来，所以必须能下断言
// （scripts/verify-timeline-geometry.mjs），否则三份前端各写一份就是三份会静默
// 画错的图。
//
// 两个面：
//   buildGeometry(spec, opts) → 结构化几何（path/area/points/events/seriesPaths/
//     yMax/measured/total/buckets/gaps/turnTicks）。交互消费者（dsh-client 的
//     React 时间线）从这里取中间结构做渲染壳。
//   buildTimeline(spec)       → 完整 SVG 字符串（或空态 <div>）。静态消费者
//     （工作台 <script src>、codex_session.html 内联）直接用。
//   buildTimeline 内部走 buildGeometry（maxBuckets: Infinity = 不抽稀，保持旧
//   输出），两条消费路径共用同一套比例尺/缺口/聚合/事件定位与合并，谁都不该
//   再写第二份。
//
// 两条不能破的语义（spec §5 不变量 5，从 DSH timeline.ts 与 Codex svTimelineSvg
// 各自踩过的坑收敛而来）：
//   1. **缺数据留缺口，不连直线**——但只对"原始值"序列（context 这类）。累计序列
//      （token/cost）缺的是"这一笔加了多少"，不是"总数归零了"，所以沿用上一格、
//      不产生缺口，缺口改由 measured/total 披露（DSH timeline.ts 的 tokens/cost
//      模式就是这么做的）。
//   2. **事件标记永不参与聚合**——曲线可以按显示宽度抽稀，风险/浪费/压缩这些标记
//      一个不丢。同 turn（或同位置）同类事件合并成一个标记、用 count/members
//      保留全部成员，这**不是**抽稀：合并后的每个标记都带 count 与 members，
//      `∑count === eventsIn` 恒成立。抽掉一次 rm -rf 不行。

(function (root, factory) {
  var geometry = factory();
  if (typeof module === "object" && module.exports) module.exports = geometry;
  // Always publish the global too: the React workbench is bundled by Vite into one
  // CommonJS wrapper whose `module.exports` exists, so an either/or UMD never set
  // `self.TimelineGeometry` and every session trace rendered as unavailable.
  if (root) root.TimelineGeometry = geometry;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = { width: 800, height: 130, pad: 26 };
  var SEV_RANK = { critical: 0, warning: 1, info: 2 };

  function fmt(n) {
    return Math.round(n * 10) / 10;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function num(n) {
    return (n == null ? 0 : Number(n)).toLocaleString("en-US");
  }

  function rank(sev) {
    return sev && sev in SEV_RANK ? SEV_RANK[sev] : 3;
  }

  // 几何坐标常量：显式 spec.geometry 优先（交互壳的 viewBox 各不相同），缺省由
  // width/height/pad 派生（曲线区 = pad..H-pad，事件行 = 曲线底线）。两套都产出
  // 同一组字段 {w,h,curveTop,curveBottom,eventY,x0,x1}，消费方只认这一组。
  function deriveGeometry(W, H, PAD) {
    return { w: W, h: H, curveTop: PAD, curveBottom: H - PAD, eventY: H - PAD, x0: PAD, x1: W - PAD };
  }

  function xAtIdx(i, n, geo) {
    return n === 1 ? (geo.x0 + geo.x1) / 2 : geo.x0 + (i / (n - 1)) * (geo.x1 - geo.x0);
  }

  // 序列的取值函数。cumulative 三态：
  //   false        原始值——缺值返回 null（断开）。
  //   true / "sum" delta 累计——缺值沿用上一格，从第一次测到才开始累计。
  //   "carry"      执行环境已给累计值——缺值沿用上一格，**不再累加**（DSH cost 轴：
  //                每行 cumulative_cost 已是截至该请求的总花费，再累一遍就双计）。
  function buildSeriesValues(points, name, cumulative) {
    var out = new Array(points.length);
    var measured = 0;
    var last = null;
    var isSum = cumulative === true || cumulative === "sum";
    var isCarry = cumulative === "carry";
    for (var i = 0; i < points.length; i++) {
      var v = points[i].values ? points[i].values[name] : null;
      v = v == null ? null : Number(v);
      if (v != null) {
        if (isSum) { last = (last == null ? 0 : last) + v; out[i] = last; }
        else if (isCarry) { last = v; out[i] = v; }
        else { out[i] = v; }
        measured++;
      } else if (isSum || isCarry) {
        // 累计/已累计序列缺行沿用上一格：缺的是"这一笔加了多少"，不是总数归零。
        out[i] = last;
      } else {
        out[i] = null;
      }
    }
    return { values: out, measured: measured };
  }

  function seriesNames(spec) {
    if (spec.series && spec.series.length) return spec.series;
    if (!spec.points.length) return [];
    var names = Object.keys(spec.points[0].values || {});
    return names.map(function (n) { return { name: n, label: n, cumulative: false }; });
  }

  function segmentPath(segs) {
    return segs.map(function (seg) {
      return seg.map(function (pt, i) {
        return (i === 0 ? "M" : "L") + fmt(pt.x) + " " + fmt(pt.y);
      }).join(" ");
    }).join(" ");
  }

  function segmentArea(segs, yFor) {
    // 单点段没有面积可填（一条零宽的竖线），跳过——否则会画出一根杂散的竖线
    // （dsh-client 的老纪律）。跨缺口的每段各自闭合到基线，缺口处不填。
    return segs.filter(function (seg) { return seg.length > 1; }).map(function (seg) {
      return "M" + fmt(seg[0].x) + " " + fmt(yFor(0)) + " " +
        seg.map(function (pt) { return "L" + fmt(pt.x) + " " + fmt(pt.y); }).join(" ") +
        " L" + fmt(seg[seg.length - 1].x) + " " + fmt(yFor(0)) + " Z";
    }).join(" ");
  }

  /**
   * buildGeometry(spec, opts) -> 结构化几何 | null。
   *
   * spec = {
   *   points: [{ ordinal, task_id?, values: { name: number|null } }],  // 已按 ordinal 升序
   *   events: [{ ordinal, kind, label?, severity?, targetId?, turn?, skillMode? }],
   *   series: [{ name, label?, cumulative? }],   // 缺省 = 第一个 point 的 values 键
   *   width, height, pad,                         // 缺省 800×130 pad26（SVG 静态路径）
   *   geometry,                                   // 可选：{w,h,curveTop,curveBottom,eventY,x0,x1}
   *   yMax,                                       // 可选：显式纵轴上限（context 窗口这类）
   * }
   * opts = { maxBuckets }   // 聚合桶数上限，缺省 220（显示宽度纪律）。Infinity = 不抽稀。
   *
   * 返回 { path, area, points, events, seriesPaths, cols, yMax, yMaxIsData,
   *        measured, total, buckets, gaps, geometry, turnTicks }。
   * 没有任何可画数据时返回 null。
   */
  function buildGeometry(spec, opts) {
    var points = spec.points || [];
    var events = spec.events || [];
    var W = spec.width || DEFAULTS.width;
    var H = spec.height || DEFAULTS.height;
    var PAD = spec.pad || DEFAULTS.pad;
    var geo = spec.geometry || deriveGeometry(W, H, PAD);
    var n = points.length;
    if (n === 0) return null;

    var series = seriesNames(spec);
    if (series.length === 0) return null;

    var cols = series.map(function (s) {
      var v = buildSeriesValues(points, s.name, s.cumulative);
      return { series: s, values: v.values, measured: v.measured };
    });
    var measuredTotal = cols.reduce(function (a, c) { return a + c.measured; }, 0);
    if (measuredTotal === 0) return null;

    var maxBuckets = opts && opts.maxBuckets != null ? opts.maxBuckets : 220;

    // y 轴上限：全序列最大值；spec.yMax（context 窗口这类显式上限）与其取大。
    // yMaxIsData 标记"上限就是数据最大值"——context 模式窗口缺失时由此告知渲染层，
    // 免得它把数据峰值当成真上限来显示。
    var dataMax = 0;
    for (var c = 0; c < cols.length; c++) {
      for (var j = 0; j < cols[c].values.length; j++) {
        var vv = cols[c].values[j];
        if (vv != null && vv > dataMax) dataMax = vv;
      }
    }
    var yMax = Math.max(dataMax, spec.yMax || 0);
    var yMaxIsData = spec.yMax == null;
    if (yMax <= 0) yMax = 1;

    var xAt = function (i) { return xAtIdx(i, n, geo); };
    var yFor = function (v) { return geo.curveBottom - (v / yMax) * (geo.curveBottom - geo.curveTop); };

    // 聚合：桶内取**最大值**而不是平均——这条曲线是用来找峰值的，平均会把一次
    // 爆掉的请求抹平。整桶全缺 → 断开（gaps++）。逐序列各聚一遍（SVG 多序列各画
    // 各的 path），交互消费者取第一个序列的 points。
    var buckets = Math.max(1, Math.min(n, maxBuckets));
    var allSegs = [];
    var gaps = 0;
    for (var s = 0; s < cols.length; s++) {
      var vals = cols[s].values;
      var segs = [];
      var cur = [];
      var g = 0;
      for (var b = 0; b < buckets; b++) {
        var lo = Math.floor((b * n) / buckets);
        var hi = Math.max(lo + 1, Math.floor(((b + 1) * n) / buckets));
        var best = null;
        var bestIdx = lo;
        for (var i = lo; i < hi && i < n; i++) {
          var v = vals[i];
          if (v == null) continue;
          if (best === null || v > best) { best = v; bestIdx = i; }
        }
        if (best === null) {
          if (cur.length) { segs.push(cur); cur = []; }
          g++;
          continue;
        }
        cur.push({ x: xAt(bestIdx), y: yFor(best), idx: bestIdx, lo: lo, hi: Math.min(hi, n) });
      }
      if (cur.length) segs.push(cur);
      allSegs[s] = segs;
      if (s === 0) gaps = g;
    }
    var first = allSegs[0];
    var pts = [];
    for (var si = 0; si < first.length; si++) pts = pts.concat(first[si]);

    // 事件定位与合并：ordinal 定位（定位不到就跳过，不画在猜的位置上）。同
    // (kind, turn) 或同 (kind, 位置) 的事件合并成一个标记——count 累加、members
    // 保留全部 targetId、代表取严重度最高的一条（T9：代表换人时 skillMode 跟着换）。
    // 合并只发生在"同一位置/同一 turn"上，`∑count === eventsIn`，不是抽稀。
    var idxOf = {};
    for (var oi = 0; oi < n; oi++) idxOf[points[oi].ordinal] = oi;
    var placed = [];
    var byKey = {};
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      var idx = idxOf[ev.ordinal];
      if (idx == null) continue;
      var key = ev.kind + "@" + (ev.turn != null ? ev.turn : "i" + idx);
      var hit = byKey[key];
      if (hit) {
        hit.count++;
        if (ev.targetId) hit.members.push(ev.targetId);
        if (rank(ev.severity) < rank(hit.severity)) {
          hit.severity = ev.severity;
          hit.label = ev.label;
          if (ev.targetId) hit.targetId = ev.targetId;
          if (ev.skillMode) hit.skillMode = ev.skillMode;
        }
        continue;
      }
      var pe = {
        kind: ev.kind,
        severity: ev.severity,
        x: xAt(idx),
        turn: ev.turn != null ? ev.turn : null,
        label: ev.label != null ? ev.label : ev.kind,
        targetId: ev.targetId || null,
        count: 1,
        members: ev.targetId ? [ev.targetId] : [],
        skillMode: ev.skillMode,
      };
      byKey[key] = pe;
      placed.push(pe);
    }
    placed.sort(function (a, b) { return a.x - b.x; });

    // turn 刻度：交互消费者横轴按请求走，人读的是 turn。最多 6 个，连续重复去重。
    var turnTicks = [];
    var tickCount = Math.min(6, n);
    for (var k = 0; k < tickCount; k++) {
      var ti = Math.round((k / Math.max(1, tickCount - 1)) * (n - 1));
      var tid = points[ti].task_id;
      if (tid == null) continue;
      var lab = "T" + tid;
      if (turnTicks.length && turnTicks[turnTicks.length - 1].label === lab) continue;
      turnTicks.push({ x: xAt(ti), label: lab });
    }

    var seriesPaths = cols.map(function (c, idx) {
      return { name: c.series.name, path: segmentPath(allSegs[idx]), area: segmentArea(allSegs[idx], yFor) };
    });

    return {
      path: segmentPath(first),
      area: segmentArea(first, yFor),
      points: pts,
      events: placed,
      seriesPaths: seriesPaths,
      cols: cols,
      yMax: yMax,
      yMaxIsData: yMaxIsData,
      measured: measuredTotal,
      total: n,
      buckets: buckets,
      gaps: gaps,
      geometry: geo,
      turnTicks: turnTicks,
    };
  }

  /**
   * buildTimeline(spec) -> SVG 字符串（或空态 <div>）。
   *
   * 静态消费者入口：工作台 `<script src>` 与 codex_session.html 内联。spec 同上，
   * 另收 classPrefix（缺省 "tl"）。内部走 buildGeometry（maxBuckets: Infinity，
   * 不抽稀，保持既有输出）；事件合并与 count 也在这里生效（同 turn 同类合并成一
   * 个 <g>，count > 1 写进 title——静态消费者没有交互面板，只能靠 title 看见
   * "这里有 N 条"）。
   */
  function buildTimeline(spec) {
    var points = spec.points || [];
    var px = spec.classPrefix || "tl";
    var n = points.length;

    if (n === 0) {
      return '<div class="' + px + '-empty">无时间线数据（该执行环境没有带时间/序号的可画点）。</div>';
    }

    var series = seriesNames(spec);
    if (series.length === 0) {
      return '<div class="' + px + '-empty">无时间线数据（没有可画的序列）。</div>';
    }

    var g = buildGeometry(spec, { maxBuckets: Infinity });
    if (g === null) {
      return '<div class="' + px + '-empty">无时间线数据（所有序列都没有测量值）。</div>';
    }

    var geo = g.geometry;
    var yFor = function (v) { return geo.curveBottom - (v / g.yMax) * (geo.curveBottom - geo.curveTop); };

    // 单点退化：折线的 X(i) 恒等于中点，line 是零长线段、area 是零宽三角形（Codex
    // svTimelineSvg 踩过的坑：session 01a029cb 单小时桶「时间线没有渲染」）。单点改
    // 画居中柱，恒非退化。
    var body = "";
    var ylabel = "";
    if (n === 1) {
      var single = g.cols[0].values[0] != null ? g.cols[0].values[0] : 0;
      var bw = Math.min((geo.curveBottom - geo.curveTop) * 0.4, 48);
      var top = yFor(single);
      var barH = (single / g.yMax) * (geo.curveBottom - geo.curveTop);
      body = '<rect class="' + px + '-bar" x="' + fmt(geo.x0 + (geo.x1 - geo.x0) / 2 - bw / 2) + '" y="' + fmt(top) +
        '" width="' + fmt(bw) + '" height="' + fmt(barH) + '" rx="4"/>' +
        '<text class="' + px + '-axis" x="' + fmt((geo.x0 + geo.x1) / 2) + '" y="' + fmt(top - 6) + '" text-anchor="middle">' +
        num(single) + '</text>';
    } else {
      // 每个序列一条 path；原始值序列缺值断开成多段（多个 M），累计序列连成一段。
      var paths = g.seriesPaths.map(function (sp) {
        return '<path class="' + px + '-line" data-series="' + esc(sp.name) + '" d="' + sp.path + '"/>';
      }).join("");
      var area = g.seriesPaths.length && g.seriesPaths[0].area
        ? '<path class="' + px + '-area" d="' + g.seriesPaths[0].area + '"/>' : "";
      body = area + paths;
      ylabel = '<text class="' + px + '-axis" x="8" y="' + fmt(yFor(g.yMax)) + '">' + num(g.yMax) + '</text>';
    }

    // 事件标记：每个（合并后的）事件一个 <g>，永不参与聚合。
    var evMarkers = "";
    for (var em = 0; em < g.events.length; em++) {
      var ev = g.events[em];
      var title = esc(ev.label || ev.kind) + (ev.count > 1 ? " ×" + ev.count : "");
      evMarkers += '<g class="' + px + '-event" data-kind="' + esc(ev.kind) + '"' +
        (ev.severity ? ' data-severity="' + esc(ev.severity) + '"' : "") +
        (ev.targetId ? ' data-target="' + esc(ev.targetId) + '"' : "") + '>' +
        '<title>' + title + '</title>' +
        '<line x1="' + fmt(ev.x) + '" y1="' + fmt(geo.curveTop) + '" x2="' + fmt(ev.x) + '" y2="' + fmt(geo.curveBottom) + '" class="' + px + '-event-tick"/>' +
        '<circle cx="' + fmt(ev.x) + '" cy="' + fmt(geo.curveTop) + '" r="3.5" class="' + px + '-event-dot"/>' +
        '</g>';
    }

    // x 轴标签：首 / 中 / 末三个点的 task_id 或序号。
    var xLabels = "";
    if (n > 1) {
      var labelIdx = [0, Math.floor((n - 1) / 2), n - 1];
      xLabels = labelIdx.map(function (i) {
        var pt = points[i];
        var lab = pt.task_id != null ? "T" + pt.task_id : String(pt.ordinal);
        return '<text class="' + px + '-axis" x="' + fmt(xAtIdx(i, n, geo)) + '" y="' + fmt(geo.h - 8) + '" text-anchor="middle">' +
          esc(lab) + '</text>';
      }).join("");
    }

    return '<svg class="' + px + '-chart" viewBox="0 0 ' + geo.w + ' ' + geo.h + '" role="img" aria-label="会话时间线">' +
      '<line class="' + px + '-grid" x1="' + geo.x0 + '" y1="' + fmt(yFor(0)) + '" x2="' + fmt(geo.x1) + '" y2="' + fmt(yFor(0)) + '"/>' +
      '<line class="' + px + '-grid" x1="' + geo.x0 + '" y1="' + fmt(yFor(g.yMax)) + '" x2="' + fmt(geo.x1) + '" y2="' + fmt(yFor(g.yMax)) + '"/>' +
      body + ylabel + evMarkers + xLabels +
      '</svg>';
  }

  // 交互消费者的命中测试：找到离 x 最近的**已画出的点**。返回 points 里的下标，
  // 没有点时返回 -1。曲线画的是桶内最大值，游标停在两点之间再插值，等于报一个
  // 从没测过的值，所以吸附到真实点。
  function nearestPoint(points, x) {
    if (!points || points.length === 0) return -1;
    var best = 0;
    var bestD = Math.abs(points[0].x - x);
    for (var i = 1; i < points.length; i++) {
      var d = Math.abs(points[i].x - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  return { buildTimeline: buildTimeline, buildGeometry: buildGeometry, nearestPoint: nearestPoint };
});
