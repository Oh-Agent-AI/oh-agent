---
title: Agent City 里的楼代表什么？楼高是怎么算的
lastUpdated: 2026-10-22
description: Agent City 里每栋会话楼对应一次 Agent 会话，楼高按总 Token 数取对数计算。逐一说明楼、城区、地标的含义。
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "文档", "item": "https://ohagent.ai/docs/zh"},
          {"@type": "ListItem", "position": 3, "name": "Agent City 里的楼代表什么", "item": "https://ohagent.ai/docs/zh/city-guide"}
        ]
      }
---

在 Agent City 里，每栋会话楼对应一次 Agent 会话，楼高随这次会话的总 Token 数增长，用的是对数曲线。每个城区对应一种 Agent，比如 Claude Code 或 Codex。除此之外，地标、海滩、车流这些大多是装饰，不代表任何数据。

## 关键事实

- **一栋会话楼 = 选定时间范围内的一次会话。**
- **楼高 = 总 Token 数**（输入、缓存读、缓存写、输出相加），按对数曲线换算，最矮 **2.6**，最高 **48**（场景单位）。
- **一个城区 = 一种 Agent**，楼的颜色就是所属城区的颜色。
- **每个时间范围最多载入 4000 次会话**，每次会话单独成一栋楼，优先保留最近的。
- 学校、商场、医院等**配套设施约每 45 次会话出现一座**。
- 岛屿**每 400 次会话扩大一档，最多 10 档**。
- 桌面版的时间范围可选 **7、30、90、366 天**。

<!-- source: apps/agent-city/ui/src/cityModel.ts（tokensToHeight；RENDER_CAP = 4_000；楼高取 row.tokens.total） -->
<!-- source: crates/agent-vitals-query/src/query/app_local.rs（SESSION_CAP = 4_000；input = uncached_input + cache_read + cache_write；total = input + output，按窗口统计） -->
<!-- source: apps/agent-city/ui/src/engine/cityLayout.ts（CIVIC_PER_SESSIONS = 45） -->
<!-- source: apps/agent-city/ui/src/engine/scaleTier.ts（SESSIONS_PER_TIER = 400，MAX_TIER = 10） -->
<!-- source: apps/agent-city/ui/src/CityApp.tsx（windowOptions = [7, 30, 90, 366]） -->

## 楼高具体怎么算？

楼高只看这次会话在当前时间范围内的总 Token 数：

```
m    = max(0, log10(tokens) − 1)
楼高 = 把 0.75 × m^2.2 限制在 2.6 到 48 之间
```

| 会话的 Token 数 | 楼高（场景单位） |
|---|---|
| 575 及以下 | 2.6（最矮） |
| 1,000 | 3.4 |
| 10,000 | 8.4 |
| 100,000 | 15.8 |
| 1,000,000 | 25.9 |
| 10,000,000 | 38.6 |
| 约 4200 万及以上 | 48（最高） |

用对数曲线，是为了让 Token 多的楼一定不比 Token 少的楼矮，同时中等规模的会话放在超大会话旁边也还看得清。场景单位是城市内部的尺度。

<!-- source: apps/agent-city/ui/src/cityModel.ts tokensToHeight()；表中数值按该公式计算 -->

## 哪些 Token 会被算进去？

在选定的时间范围内，这次会话记录到的未缓存输入、缓存读取、缓存写入和输出 Token 全部相加。这里的“记录到”，指的是 Agent 在这台电脑 上留下的日志，不一定是你在所有设备上的完整历史。

<!-- source: crates/agent-vitals-query/src/query/app_local.rs；README.md（“Read the numbers honestly”） -->

## 为什么楼的样子各不相同？

楼的样子由地块“地价”决定，跟数据无关。靠近城区中心、主干道和水边的好地块，会话楼会长成玻璃幕墙塔楼；地价低的地块上，会变成又宽又浅的板楼或街坊楼。海边较矮的会话楼会换成迈阿密装饰艺术风格；落在海滨酒店地块上的会话会变成一栋酒店。但不管长成什么样，**楼高都只由 Token 决定**。

<!-- source: apps/agent-city/ui/src/i18n.tsx（建筑说明：会话塔楼、会话板楼/街坊楼、海滨装饰艺术楼、海滨酒店） -->

## 城区、地标、市政厅分别是什么意思？

| 元素 | 表示什么 | 跟数据有关吗 |
|---|---|---|
| 城区 | 一种 Agent（执行环境），比如 Claude Code、Codex。楼都用城区的颜色 | 有关 |
| 城区地标 | 每个城区中心有一座三级收分的装饰艺术塔，城区会话越多塔越高，回放时会一层层加盖 | 有关（会话数） |
| 全城之最 | 当前时间范围内 Token 最多的那次会话。楼顶戴尖顶冠，黄昏后亮起一道探照光柱 | 有关 |
| 市政厅 | 门前城区旗的高度表示各城区的会话占比；穹顶亮起信标，说明有城区出现异常 | 有关 |
| 学校、商场、医院 | 反映城市规模，约每 45 次会话一座，不对应某一次会话 | 只反映规模 |
| 岛屿档位 | 每 400 次会话扩大一档，最多 10 档 | 只反映规模 |
| 背景楼 | 灰调的天际线填充。不能点，不计入统计，可以在“城市设置”里关掉 | 无关 |
| 种子地标（电视塔、灯塔、摩天轮、宝塔等） | 由岛屿种子挑选 | 无关 |
| 海滩、港口、机场岛、火山、桥、环线高架 | 城市的风景和骨架 | 无关 |
| 车流、船、行人 | 氛围动画 | 无关 |

<!-- source: apps/agent-city/ui/src/i18n.tsx（建筑说明：城区地标、全城之最、市政厅、背景楼、地标、海滨、机场岛等） -->
<!-- source: Haru 分析 city-traffic-feasibility.md（车流、船只、行人目前只是装饰）——请维护者发布前确认 -->

## 会话超过 4000 次会怎样？

每个时间范围，桌面版最多载入 4000 次会话，按最近活动优先保留，并在城市里显示覆盖情况：显示了多少次，一共找到多少次。缺失的记录不会用虚构的活动补上。城市渲染器本身也能把超出 4000 栋容量的会话合并成低细节楼群，不过在目前 4000 次的载入上限下，正常情况不会触发。

<!-- source: crates/agent-vitals-query/src/query/app_local.rs（SESSION_CAP = 4_000，按最近活动排序 LIMIT，并返回总数）；apps/agent-city/ui/src/cityModel.ts（UI 显示 coverage.returned/total）；apps/agent-city/ui/src/i18n.tsx（聚合楼群）；website/landing/i18n.js faq.4（注意：官网这条仍写 500，已过时） -->

## 城市布局是随机的吗？

不是。布局由一个种子加上岛屿档位生成，种子和档位相同，生成的城市就相同。种子保存在应用的本机数据目录里（`state/plugins/city.json`）。

<!-- source: apps/agent-city/ui/src/engine/cityPlan.ts（createCityPlan(seed, tier)）；apps/desktop/src-tauri/src/plugin_projections.rs（state/plugins/city.json） -->

## 能回放城市长起来的过程吗？

能。桌面版可以回放所选时间范围内的活动，回放速度可以调。[网页演示](https://ohagent.ai/)也能用模拟数据探索楼和回放，但隐藏了游戏、导出和种子相关的控件。

<!-- source: README.md（Activity replay）；apps/agent-city/ui/src/i18n.tsx（回放速度、拍照、导出视频）；website/landing/README.md（presentation=landing 隐藏游戏、导出和种子控件） -->

## 城市越高，说明我干得越好吗？

不是。城市只是把记录到的活动画出来，不是生产力评分。楼长高不代表任务完成了，反复重试也不等于白干。楼的详情里会显示估算费用，但费用不影响楼高，估算也不等于账单。

<!-- source: README.md（“不是生产力排名。建筑生长不代表任务完成，重试也不等于浪费”）；website/landing/i18n.js faq.6 -->

## 相关页面

- [Agent City 介绍](https://ohagent.ai/#city)
- [Claude Code 数据来源](/docs/zh/data-sources/claude-code) · [Codex 数据来源](/docs/zh/data-sources/codex)
- [Oh Agent 会上传我的会话吗？](/docs/zh/privacy-and-data)
- [常见问题](https://ohagent.ai/#faq)
