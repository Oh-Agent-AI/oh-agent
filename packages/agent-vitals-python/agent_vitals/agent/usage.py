"""会话级成本折叠 —— 把 usage 事件按当时活跃的模型分桶。

与 behavior.py（SV601–610 风险规则）是两条正交的审计维度：风险规则输出
finding 列表，这里输出 `{"by_model": {model: 四桶}, "sequence": [模型激活序列]}`。

折叠语义与 DSH token-meter（packages/llm/token-meter/src/usage-projection.ts
的 tokenUsageProjectionDefinition）完全一致，并已用真实日志对账：各桶之和
== tokenUsage 投影累计值（94997694 会话 180577354/498735/712320/0 逐字节
一致）。这里是 Python 平行实现，单一真相源是
`crates/agent-vitals-domain/src/domain/usage.rs`；差分防护在 core 的 parity 测试与
`tests/test_cli_matrix.py` 的双实现逐字节比较。

三个关键语义（为什么这样实现，对应共性缺陷）：
- **按模型分桶**：request/header 的 config.model 会在会话中途变化（真实日志
  出现过 pro → flash → pro），`tokenUsage` 投影只有全会话累计、没有模型维度
  ——拿一个模型价算整段账会错 3 倍（flash 与 pro 输入价差 3 倍）。
- **同 (turn, step) 去重**：usage chunk 先到、assistant/message 后到是同一
  step 的两份 sample，只计最后一份；替换时从**原归属模型**减掉旧值——否则
  双计会让分桶之和超过真实累计。
- **无活跃模型归 unknown**：老日志无 request/header 时宁缺勿造，落进
  `"unknown"` 桶由展示层标「未计价」，绝不臆造一个模型。

每个桶除四个全量字段外还带四个 peak_* 子字段——落在北京高峰时段（**周一至
周五** 9–12、14–18 点；周末全天为空闲）的部分，由触发这份贡献的事件自己的
time 字段判定。这让展示层能算
出真实发生的费用（按每笔请求实际的时段计价），而不是「给空闲价和高峰价两个
数，猜不出实际该按哪个算」的区间估算——旧注释说「累计桶无法重建每笔请求的
时刻」，那是折叠时把 time 直接扔掉的自我实现，不是数据不存在。
"""

import json
from datetime import date, timedelta
from typing import NamedTuple, Optional

from ..util import est_tokens, post_fork
from ..source_identity import canonical_json, fnv1a64_hex  # §3.3 身份哈希原语（与 claude/codex/UsageFact ID 同一边界）

_EPOCH_DATE = date(1970, 1, 1)


_EMPTY_BUCKET = {
    "uncached_input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "peak_uncached_input_tokens": 0,
    "peak_output_tokens": 0,
    "peak_cache_read_tokens": 0,
    "peak_cache_write_tokens": 0,
}

_BEIJING_OFFSET_SECS = 8 * 3600


def _beijing_hour(time_ms):
    """Unix ms → 北京时间小时数 [0,24)。中国自 1991 年起全境固定 UTC+8、无夏
    令时，这是精确换算。"""
    secs = time_ms // 1000 + _BEIJING_OFFSET_SECS
    return (secs % 86400) // 3600


def _beijing_weekday(time_ms):
    """Unix ms → 北京时间星期几（周一=0 … 周日=6）。

    1970-01-01 是星期四（以周一=0 计即 3），所以 `(天数 + 3) % 7`。用纯整数算，
    不引日期库——Python 的 // 和 % 对负数本身就是向下取整/取正余数，1970 年
    之前的负时间戳也对。
    """
    secs = time_ms // 1000 + _BEIJING_OFFSET_SECS
    return (secs // 86400 + 3) % 7


def _is_peak_slot(time_ms):
    """高峰时段：北京时间**周一至周五**的 9–12 点、14–18 点（左闭右开）。
    其余一切时间（含周六周日全天）都是空闲时段，空闲价 = 高峰价的一半。

    **周末那一条以前漏了**，代价是精确的 2 倍：真实账单对照（2026-08-23 周日
    14:45 那次会话）我们算 ¥1.0308372、官方收 ¥0.5154186，正好 ×2.0000——
    29 次请求的 token 数逐位吻合，只有时段判错。而且这条从来没被真实账单验证
    过：上一次对账的会话跑在 21–22 点，全程落在空闲时段，走的根本不是这个
    分支，所以碰巧对上了。
    """
    if _beijing_weekday(time_ms) > 4:
        return False  # 周六(5)、周日(6) 全天空闲
    hour = _beijing_hour(time_ms)
    return (9 <= hour < 12) or (14 <= hour < 18)


def _is_peak(event):
    """事件是否落在高峰时段。缺 time（老日志/畸形事件）保守按空闲算——峰值
    单价更高，宁可少算费用也不要凭空安一个「高峰」时刻上去（不臆造）。"""
    time_ms = event.get("time")
    if not isinstance(time_ms, int) or isinstance(time_ms, bool):
        return False
    return _is_peak_slot(time_ms)


def _int_or_none(v):
    """缺字段/布尔返回 None；真整数原样返回（token 数不会为负/浮点）。"""
    return v if isinstance(v, int) and not isinstance(v, bool) else None


# usage sample 的四个字段名（日志里的 camelCase），顺序与 _BASE_KEYS 对齐。
#: 同一模型名在一次会话里被两家供应商服务过时的标记。故意用一个不可能是
#: 真实供应商名的字符串：它不会命中 priced_providers 白名单，于是自动落进
#: 「不计价」——不需要计价方再认一个特殊分支。
AMBIGUOUS_PROVIDER = "__ambiguous__"

#: per-source 拆账的来源标签（吸收 cc-switch 的 DataSourceSummary 思路）：
#: 一次 `token_by_date_model` 喂入的整批事件标一个来源，由**调用方显式标注**，
#: 绝不从浏览器/渲染层猜。来源缺失 → `unspecified`（诚实降级，不编造来源名）。
SOURCE_DSH_LIVE = "dsh-live"      # watcher/增量 fold（DSH 会话存储实时路径）
SOURCE_DSH_BACKFILL = "dsh-backfill"  # session_index/archived_sessions 补扫
SOURCE_CODEX = "codex"            # Codex 会话导入
SOURCE_CLI = "cli"                # CLI 重喂（oneline/calendar 重跑同一批 —— 2026-08
                                  # 「日历 ¥2386 vs 按 session 重算 ¥1733」事故的 (a) 根）
SOURCE_UNSPECIFIED = "unspecified"

_SAMPLE_FIELDS = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")


def _buckets_from(usage, seen=None):
    """usage sample → 四桶。字段映射与 token-meter `bucketsFrom` 完全一致
    （reasoning 已含在 outputTokens，不重复计）。

    缺字段仍按 0 累加——这是**求和**的正确语义，且四桶之和必须与 DSH 的
    `tokenUsage` 逐字节相等（已对账的不变量，不能动）。但「求和按 0」不等于
    「测到了 0」：`seen` 收集**真正出现过**的字段名，由 `token_by_model` 折成
    `unreported_fields`，让展示层能写「未上报」而不是「0」。

    这条区分是有实测依据的：真实会话（session-e4b0be69）的 1398 个 usage 样本
    （720 条 assistant/chunk + 678 条 assistant/message）里 `cacheWriteTokens`
    **一次都没出现过**，`cacheReadTokens` 出现 1348 次。（早先这条注释写的是
    「679 个样本」——那个数只数了 assistant/message 一种类型，漏了
    assistant/chunk；发现于事后核对真实日志时，已更正。）原来
    `or 0` 把「执行环境根本不报这个字段」和「执行环境报了 0」合并成同一个 0，UI 于是
    显示「缓存写 0」——一个被伪造出来的测量值。这与 CLAUDE.md 的纪律直接冲突：
    缺列的报告有用，编造列的报告没用（harness 能力缺失时降级、绝不臆造）。
    """
    if seen is not None:
        for name in _SAMPLE_FIELDS:
            if _int_or_none(usage.get(name)) is not None:
                seen.add(name)
    return {
        "uncached_input_tokens": _int_or_none(usage.get("inputTokens")) or 0,
        "output_tokens": _int_or_none(usage.get("outputTokens")) or 0,
        "cache_read_tokens": _int_or_none(usage.get("cacheReadTokens")) or 0,
        "cache_write_tokens": _int_or_none(usage.get("cacheWriteTokens")) or 0,
    }


#: 残差哨兵递归深度上限。真实 payload 里 usage 最深出现在 `data.usage.*`
#: （2 层）；给到 6 层是留余量，同时避免在 `compaction/summary.rawOutput`
#: 这类大对象上无界递归。
_SHAPE_SCAN_MAX_DEPTH = 6
#: 单个列表最多看前 N 个元素——同上，防止在长文本块数组上退化。
_SHAPE_SCAN_MAX_ITEMS = 32


def usage_shaped_tokens(node, depth=0):
    """在一份 payload 里找**我们认识的** usage 字段，返回它们的和；没有则 None。

    这是「残差哨兵」的判据。它故意只认 `_SAMPLE_FIELDS` 这四个名字——就是
    折叠自己会读的那四个。所以它回答的问题非常精确：

        「这条事件的 payload 里有我们**认得**的 token 字段，
          但它没被 `_usage_sample` 接住。」

    而不是宽泛的「这看起来像某种用量」——后者会在 `maxTokens`、
    `shadowedTokenCount`、`model_context_window` 这类**配置/统计**字段上误报，
    把哨兵变成没人看的噪音。

    **哨兵只用于「留候选 + 报警」，绝不用于计价。** 同一笔用量会在多个事件
    里重复出现（`assistant/chunk` 先报一次、`assistant/message` 再报最终值，
    这正是 `(turn, step)` 去重在解决的问题），把结构识别的结果直接算进钱里
    就是双计。计价必须走 `_usage_sample` 那条显式注册的路径——机器负责
    **发现**，人负责**归类**。

    真实来由：DSH 的 `compaction/summary` 带 `data.usage`（实测
    `{inputTokens:462, outputTokens:3520, cacheReadTokens:245760}`）且自带
    `model`/`provider`，但因为 ① 不在 `_usage_sample` 的类型白名单里、
    ② 没有 `turn`/`step`（compaction 由命令触发，不属于任何 turn），
    被静默丢弃——用户在菜单栏上肉眼发现"今天有消耗但日历是 0"才暴露。
    """
    if depth > _SHAPE_SCAN_MAX_DEPTH:
        return None
    total = None
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _SAMPLE_FIELDS:
                n = _int_or_none(value)
                if n is not None:
                    total = (total or 0) + n
                    continue
            sub = usage_shaped_tokens(value, depth + 1)
            if sub is not None:
                total = (total or 0) + sub
    elif isinstance(node, list):
        for value in node[:_SHAPE_SCAN_MAX_ITEMS]:
            sub = usage_shaped_tokens(value, depth + 1)
            if sub is not None:
                total = (total or 0) + sub
    return total


_BASE_KEYS = ("uncached_input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
_PEAK_KEYS = ("peak_uncached_input_tokens", "peak_output_tokens", "peak_cache_read_tokens", "peak_cache_write_tokens")


def _record_provider(providers, model, provider):
    """登记"这个模型名这次是哪家供应商服务的"，处理三种取值——
    见 `token_by_model` 里这段逻辑原本的详细注释（`request/header` 分支）。
    抽成函数是因为 `compaction/summary` 现在也会带自己的 model/provider，
    需要跟 `request/header` 走同一套"未上报 vs 唯一供应商 vs 两家服务过
    同一模型名"的判定，两处各写一份迟早分叉。
    """
    if not isinstance(provider, str):
        provider = None
    if model not in providers:
        providers[model] = provider
    elif providers[model] != AMBIGUOUS_PROVIDER and providers[model] != provider:
        providers[model] = AMBIGUOUS_PROVIDER


def _add_buckets(by_model, model, buckets, sign, peak):
    """分桶相加。`sign=-1` 用于替换语义（从原归属模型减掉旧值）。`peak` 决定
    这份贡献是否也叠进 peak_* 子桶——四个基础桶始终是全量（空闲+高峰），
    peak_* 只是其中高峰时段的子集，off-peak 由展示层用 全量 − peak 推出。"""
    cur = by_model.setdefault(model, dict(_EMPTY_BUCKET))
    for key in _BASE_KEYS:
        cur[key] = cur[key] + sign * buckets[key]
    if peak:
        for base_key, peak_key in zip(_BASE_KEYS, _PEAK_KEYS):
            cur[peak_key] = cur[peak_key] + sign * buckets[base_key]


#: compaction 的 (turn, step) 命名空间——真实 turn 永远非负，这里全部取负数，
#: 结构上不可能撞真实 turn/step。
_COMPACTION_STEP = 0


def _compaction_identity(compaction_id):
    """把 `compactionId` 映射成一个跟真实 turn 不冲突的负数——当 compaction
    的 `(turn, step)` 去重身份。

    compaction **不属于任何 turn**（`compaction/start` 里 `"turn": null`，
    由 `sourceCommandId` 触发，不是某一轮对话的产物），伪造一个 turn 号会
    跟真实样本抢 `(turn, step)` 去重槽。但去重槽本身是 `(int, int)` 形状，
    改成第三种"独立 id"类型要牵动 `token_by_model`/`hour_buckets`/
    `request_metrics`/`token_by_date_model` 四处的 dedup slot 定义,以及
    Rust 平行实现——用哈希把 `compactionId` 稳定映射进负数空间,不用改
    任何一处的 slot 类型,是这四处改动量最小、且行为完全正确的做法。

    用哈希而不是自增计数器：本函数是无状态纯函数,不能维护跨调用计数器;
    哈希对同一个 `compactionId` 总产出同一个值，这正是去重需要的性质——
    真实撞见过一次 compaction 被 fork 复制进 4 个会话文件,4 份 summary
    落进同一个槽,`(turn,step)` 相同、`buckets` 相同，`token_by_model`
    的"值相同就跳过"分支会正确地只算一次（`post_fork` 已经会滤掉大多数
    这类副本，这里是双保险，不依赖 post_fork 覆盖所有场景）。

    缺 `compactionId`（不应该发生，但宁可退化也不崩）时退化成一个固定值,
    此时同一会话里的多次 compaction 会互相覆盖只保留最后一次——比崩溃或
    静默丢弃这一个样本更好，且极端情况在真实语料里没出现过。
    """
    if not isinstance(compaction_id, str) or not compaction_id:
        return -1
    import hashlib
    digest = hashlib.sha256(compaction_id.encode("utf-8")).hexdigest()
    return -1 - (int(digest[:8], 16) % (2 ** 30))


def _usage_sample(event, etype, data):
    """usage 事件 → (turn, step, usage, model_override)；非 usage 或畸形返回 None。

    `model_override` 是 `(model, provider)` 或 `None`——大多数事件类型没有
    自己的模型信息，沿用调用方从 `request/header` 追踪的"当前激活模型"
    （返回 `None`）；`compaction/summary` 是例外，它自带 `data.model`/
    `data.provider`（真实实测：会话主体用 pro/flash 混合，但 compaction
    走的是 `deepseek-v4-flash`/`deepseek-official`，跟当时激活的模型
    不是同一个）——不能落进"当前激活模型"，那会把这笔钱记错供应商/模型，
    价格算错。

    `token_by_model` / `request_metrics` / `token_by_date_model` /
    `hour_buckets` **共用**这一个提取器（Rust 侧同名 `usage_sample` 亦然）
    ——四者的去重语义必须一致，各写一遍迟早分叉。这也是新增
    `compaction/summary` 只改这一处、四个消费者自动生效的原因。
    """
    if etype == "assistant/chunk":
        chunk = data.get("chunk")
        if not isinstance(chunk, dict) or chunk.get("type") != "usage":
            return None
        turn, step, usage = data.get("turn"), data.get("step"), chunk.get("usage")
        model_override = None
    elif etype == "assistant/message":
        if "usage" not in data:
            return None
        turn, step, usage = data.get("turn"), data.get("step"), data.get("usage")
        model_override = None
    elif etype == "compaction/summary":
        usage = data.get("usage")
        if not isinstance(usage, dict):
            return None
        turn = _compaction_identity(data.get("compactionId"))
        step = _COMPACTION_STEP
        model = data.get("model")
        model_override = (
            model if isinstance(model, str) else None,
            data.get("provider") if isinstance(data.get("provider"), str) else None,
        )
    else:
        return None
    if (_int_or_none(turn) is None or _int_or_none(step) is None
            or not isinstance(usage, dict)):
        return None
    return turn, step, usage, model_override


def _opt_int(usage, key):
    """usage sample 的单个字段：在场取值，缺席取 None。

    与 `_buckets_from` 的「缺字段按 0」是**两种正确语义**：那边在求和（四桶之和
    必须与 DSH tokenUsage 逐字节相等），求和里缺项当 0 是对的；这里是逐请求的
    测量值，缺项落 0 就是把「执行环境没报」伪造成「测到 0」。
    """
    return _int_or_none(usage.get(key))


def _resolve_raw(self_val, active_val):
    """§3.4 的 model_raw/provider_raw 判定：样本自带的 self（仅 compaction 有）
    **非空**取 self，否则回落那一刻的 active 游标；普通请求 self_val 恒 None →
    直接取 active。

    空串是退化值、不是 str 缺失，不冒充证据——`_usage_sample` 在 data.model=""
    时给 ""，空串两侧都回落 active。这条同时收敛了 Python 渲染真值语义（旧的
    `model_self if model_self else model_active`）与 Rust `match Some(m) => m` 的
    **历史分歧**（Rust 过去把空串渲染成 ""、Python 渲染成 active）：现在两侧同一
    谓词，request_metrics 的 model 列才逐字节一致。
    """
    return self_val if self_val else active_val


class DshUsageObservation(NamedTuple):
    """逐相邻槽的一条 usage 观察——`request_metrics`（展示）与 UsageFact
    emitter（Commit 2，事实）的**共享观测**，`dsh_usage_observations` 逐槽产出。

    槽语义与聚合 fold 同款：**相邻 run**（`last` 同 (turn, step) 比较），**不是**
    全文件 HashMap 去重——非相邻的同 (turn, step) 重现是两个独立槽（普通请求因
    `first_sample_seq` 不同而身份各异；同 compactionId 重现则 collide，靠
    Commit 2 的 duplicate 守卫）。字段分两组：

    - **槽身份（开槽即固化、shadow 永不覆盖）**：`is_compaction`/`turn`/`step`/
      `compaction_id` 定义这个槽是谁（compaction 的 turn/step 置 None——内部去重
      用的 `_compaction_identity` 负号哈希是实现细节，不泄漏成真实 turn 号）；
      `identity_basis`/`source_event_id`/`first_sample_seq`/
      `first_sample_identity_hash` 是**身份形成的唯一边界**：观察者在该槽**第一个**
      被消费的 usage 样本到达时（开槽）按 §3.3 三段公式算好并冻结，shadow 一律
      不覆盖——无 compactionId 的 compaction 折进固定负号槽，相邻后续同槽样本会
      让支配样本变化，若身份 hash 取支配样本 canonical 行，append 一条 shadow 后
      hash/fact_id 就变（v3 的错，v4 拍板改）。
    - **支配样本 value（shadow 可覆盖）**：同一相邻槽内后来的 usage 样本（如 chunk
      后的 message、双 chunk 后到者、相邻同槽 compaction 重现）覆盖
      `seq`/`time`/`model_raw`/`provider_raw`/`context_window`/`context_tokens`/
      四桶/`is_peak`——每份 sample 都按**那一刻**的 active 游标重判 model/provider
      （§3.4，与 fold/request_metrics 的「后到重判」一致），**不缓存成槽建立时的
      值**（header 若在 chunk/message 之间变化，缓存会让 observer 与 fold 分叉）。

    `source_event_id` 由 observer 直接携带（不是 Commit 2 emitter 复算——emitter 只
    消费、绝不重读日志）。`first_sample_identity_hash` 仅无 compactionId 的
    compaction 非 None（开槽样本 canonical 行 hash）；其余恒 None。
    """

    # 槽身份——开槽即固化，shadow 永不覆盖
    is_compaction: bool
    turn: Optional[int]           # 真实 turn；compaction 槽 = None（不泄漏内部负号哈希）
    step: Optional[int]           # 真实 step；compaction 槽 = None
    compaction_id: Optional[str]  # 原生 data.compactionId（str 非空）；非 compaction = None
    identity_basis: str           # §3.3："native" iff compaction 有原生 id，否则 "derived-hash"
    source_event_id: str          # §3.3 三段公式：request:derived:… / compaction:<id> / compaction:derived:<hash>
    first_sample_seq: Optional[int]  # 槽首个被消费 usage 样本的 seq（append 稳定锚）
    first_sample_identity_hash: Optional[str]  # 仅无 id compaction：开槽样本 canonical 行 hash；其余 None
    # 支配样本 value——shadow 可覆盖（开槽时 == 开槽样本本身）
    seq: Optional[int]            # 支配样本的 seq
    time: Optional[int]           # 支配样本的 time
    # §3.4：普通 = 支配样本那一刻的 active config.model/provider；compaction = 自带
    # data.model/provider（非空 str）否则回落 active。只允许原始字符串或 None。
    model_raw: Optional[str]
    provider_raw: Optional[str]
    context_window: Optional[int]
    context_tokens: Optional[int]
    uncached_input_tokens: Optional[int]
    output_tokens: Optional[int]
    cache_read_tokens: Optional[int]
    cache_write_tokens: Optional[int]
    is_peak: Optional[bool]


def dsh_usage_observations(events):
    """逐相邻槽产出 `DshUsageObservation`（Rust 镜像见 `usage.rs`）。

    这是从 request_metrics 原循环抽出的**共享逐槽 observer**（v0.7 Stage 3 Commit
    1）：request_metrics 原先自己维护一条「request/header 追踪 active model →
    逐样本提取 → 同槽去重」的循环，与 `_usage_fold_into` 各写一遍槽语义，且这条
    循环**丢弃了 provider 与首样本身份**——这正是「UsageFact 不能消费它」的根因。
    抽成 observer 后同时服务 request_metrics（展示）与 emitter（Commit 2，事实）。

    v4（review P0 拍板）：身份形成的**唯一边界**在开槽。observer 在该槽**第一个**
    样本到达时按 §3.3 三段公式算好并冻结 `source_event_id`/`identity_basis`/
    `first_sample_seq`/`first_sample_identity_hash`——`source_event_id` 直接带在
    observation 上（Commit 2 emitter 只消费、绝不重读日志复算）；相邻 shadow 只
    `_replace` value 字段，身份字段不列出即不触碰，结构性保证「append 一条 shadow
    不改写旧 fact_id 的身份输入」。

    **`token_by_model` 的聚合 fold 不接 observer**、继续走 `_usage_fold_into`——
    观察者与聚合 fold 是两条**已 reconcile** 的路径，不是唯一逐槽解释；四桶之和
    相等由测试钉死。`_usage_sample` 仍是逐样本提取的唯一入口，observer 与 fold
    共用。active 游标（config.model/config.provider）推进规则与 fold 的 active +
    `_record_provider` 同谓词：config.model 为 str 才推进 model 游标，provider 取
    `config.provider` 原样 str-or-None。
    """
    events = post_fork(events)
    observations = []
    active_model = None    # request/header 的 config.model 游标（str 才推进）
    active_provider = None  # request/header 的 config.provider 游标（原样 str-or-None）
    window = None          # request/context 的 contextWindow 游标（最近一次上报）
    last_key = None        # 同 (turn, step) 相邻槽去重

    for event in events:
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        data = event.get("data")

        if etype == "request/header":
            if isinstance(data, dict):
                header = data.get("header")
                if isinstance(header, dict):
                    config = header.get("config")
                    if isinstance(config, dict) and isinstance(config.get("model"), str):
                        active_model = config["model"]
                        provider = config.get("provider")
                        active_provider = provider if isinstance(provider, str) else None
            continue
        if etype == "request/context":
            # 缺 contextWindow 时保留上一次的值——一次畸形事件不该让后面所有
            # 请求都失去分母。真实日志里它一个会话只出现 5 次（每次模型切换各
            # 一次），所以只能沿用最近值，不能按请求去找。
            if isinstance(data, dict):
                w = _int_or_none(data.get("contextWindow"))
                if w is not None:
                    window = w
            continue

        if not isinstance(data, dict):
            continue
        sample = _usage_sample(event, etype, data)
        if sample is None:
            continue
        turn, step, usage, model_override = sample
        # compaction 的 (turn, step) 是内部去重用的哈希身份（见
        # `_compaction_identity`），不是真实存在的 turn 号——观察者这一槽必须诚实
        # 写 None（缺列不编列，把去重实现细节泄漏成负数就是编造）；去重键仍用内部
        # (turn, step)，相邻同槽判断与 fold 同款。
        is_compaction = etype == "compaction/summary"

        # 样本自带 model/provider（§3.4 的 self 半边）：仅 compaction 有，且已由
        # `_usage_sample` 判成 str-or-None（含空串退化值）。
        if is_compaction:
            cid = data.get("compactionId")
            compaction_id = cid if isinstance(cid, str) and cid else None
            model_self, provider_self = model_override
        else:
            compaction_id = None
            model_self = provider_self = None

        first_seq = _int_or_none(event.get("seq"))
        time_ms = _int_or_none(event.get("time"))
        uncached = _opt_int(usage, "inputTokens")
        cache_read = _opt_int(usage, "cacheReadTokens")
        # 两项都在场才给 context_tokens；少一项整行留空。
        context_tokens = (uncached + cache_read
                          if uncached is not None and cache_read is not None else None)

        # 支配样本 value——shadow 分支用它对 prev `_replace`（身份字段不在 dict 里，
        # 即不触碰 = 原样保留）；开槽分支直接构造新 observation。
        value = {
            "seq": first_seq,
            "time": time_ms,
            # §3.4：self 非空取 self、否则回落那一刻 active 游标（普通请求 self 恒
            # None → 即 active；空串两侧都回落，见 `_resolve_raw`）。
            "model_raw": _resolve_raw(model_self, active_model),
            "provider_raw": _resolve_raw(provider_self, active_provider),
            "context_window": window,
            "context_tokens": context_tokens,
            "uncached_input_tokens": uncached,
            "output_tokens": _opt_int(usage, "outputTokens"),
            "cache_read_tokens": cache_read,
            "cache_write_tokens": _opt_int(usage, "cacheWriteTokens"),
            # 这笔请求是否落在北京高峰时段。**规则留在这里，价格留给调用方**：
            # 展示层要画逐请求费用曲线就必须知道每笔按高峰价还是空闲价算，
            # 让浏览器自己重算一遍 _is_peak 就是这条规则的第四份拷贝。
            # 时间戳缺失时为 None——不是 False（"没测到"不等于"不在高峰"）。
            "is_peak": _is_peak(event) if time_ms is not None else None,
        }

        if last_key == (turn, step) and observations:
            # 后到者覆盖（与 token_by_model 的替换语义一致）；只覆盖 value 字段，
            # 槽身份/身份固化字段原样保留——append 一条 shadow 不改写旧 fact_id。
            observations[-1] = observations[-1]._replace(**value)
            continue

        # ── 开槽：身份形成的唯一边界（§3.3 三段公式，一律此刻算好并冻结）──
        if is_compaction and compaction_id is not None:
            # 有 compactionId：compaction_id 是执行环境原生标识 → native 身份，无 hash。
            identity_basis = "native"
            source_event_id = "compaction:" + compaction_id
            identity_hash = None
        elif is_compaction:
            # 无 compactionId：对开槽样本 canonical 行算 hash 并冻结。首样本重塑
            # 事件 {type, time, data}，seq 为整数才追加（hash 对象永不带 null 键）。
            identity_basis = "derived-hash"
            identity_row = {"type": etype, "time": event.get("time"), "data": data}
            if first_seq is not None:
                identity_row["seq"] = first_seq
            identity_hash = fnv1a64_hex(canonical_json(identity_row))
            source_event_id = "compaction:derived:" + identity_hash
        else:
            # 普通请求：canonical 身份元组 {turn, step}，seq 为整数才追加、None 就
            # 整体省略该键。first_sample_seq 本身就是冻结值，但为统一存固化字段。
            identity_basis = "derived-hash"
            identity_hash = None
            identity_row = {"turn": turn, "step": step}
            if first_seq is not None:
                identity_row["seq"] = first_seq
            source_event_id = "request:derived:" + fnv1a64_hex(canonical_json(identity_row))

        observations.append(DshUsageObservation(
            is_compaction=is_compaction,
            turn=None if is_compaction else turn,
            step=None if is_compaction else step,
            compaction_id=compaction_id,
            identity_basis=identity_basis,
            source_event_id=source_event_id,
            first_sample_seq=first_seq,
            first_sample_identity_hash=identity_hash,
            **value,
        ))
        last_key = (turn, step)
    return observations


def request_metrics(events):
    """逐请求指标（PRD §9.3 RequestMetric）。Rust 平行实现见 `usage.rs`。

    与 `token_by_model` 是**同一个 fold 的两个出口**：那边把每个样本折进按模型
    的总数，这里保留每次请求自己的一行。会话健康时间线上的每个点都来自它。
    不变量：逐请求四桶之和 == token_by_model 四桶之和（两侧都有测试钉死）。

    自 v0.7 Stage 3 Commit 1 起这里是 `dsh_usage_observations` 的**一薄渲染**：
    逐槽折叠循环已抽进 observer（共享 `_usage_sample` + active 游标 + 相邻槽
    去重 + §3.3/§3.4 身份与 model_raw 解析），这里只把每条 observation 映成一行
    JSON，输出**逐字节不变**——新携带的 source_event_id/身份字段不渲染。model 列
    直接用 observer 解析好的 `model_raw`（§3.4：compaction 自带或 active 游标），
    无证据才落 "unknown" 渲染哨兵。

    三条诚实性约定（与本仓「缺列不编列」同一条纪律）：
    - 缺字段落 None（JSON null）不落 0；
    - `context_tokens` 只在两个加数都在场时才非空——真实会话 687 个请求点里
      13 个缺 cacheReadTokens，这些点该在图上留缺口，而不是拿部分和凑一个偏低值；
    - **不输出逐请求的 `compacted` 布尔列**：压缩事件类型已确认（见 `compaction.py`），
      但它独立于请求，不该硬塞成每行一个 True/False；真正的压缩视图是
      `compaction_events()` 单独的输出。
    """
    rows = []
    for obs in dsh_usage_observations(events):
        rows.append({
            "request_seq": 0,  # 去重后统一回填
            "seq": obs.seq,
            "time": obs.time,
            "turn": obs.turn,
            "step": obs.step,
            "model": (obs.model_raw if obs.model_raw is not None else "unknown"),
            "context_window": obs.context_window,
            "context_tokens": obs.context_tokens,
            "uncached_input_tokens": obs.uncached_input_tokens,
            "output_tokens": obs.output_tokens,
            "cache_read_tokens": obs.cache_read_tokens,
            "cache_write_tokens": obs.cache_write_tokens,
            "is_peak": obs.is_peak,
        })

    # request_seq 在去重之后才有意义：它是「第几个请求点」，不是「第几个样本」。
    for i, row in enumerate(rows):
        row["request_seq"] = i + 1
    return rows


def context_composition(events):
    """常驻上下文构成（PRD FR-04a）。Rust 平行实现见 `usage.rs`。

    返回**每次请求都要重发的那段前缀**的分类估算：

        system_tokens   ← request/header.data.header.system
        tools_tokens    ← request/header.data.header.tools（序列化后）
        catalog_tokens  ← source.kind == "skill-catalog" 的 entries[].name + description
        catalog_names   ← 上面那份的逐条拆分 [{"name", "tokens"}]（T1，不带 description
                          原文——FR-SK-09 要求导出不含未脱敏内容，进投影的东西迟早流
                          进导出，逐 skill「目录 Token」只需要这个数）

    **这三个数与 request_metrics 的 context_tokens 不是同一个估算器，不能相加
    相等。** 真实会话实测：首次请求的常驻前缀 est_tokens = 10,830，而 provider
    报的 uncached + cacheRead = 13,959，差的 3,129 是首条用户消息与消息封套开销。
    所以本函数只给常驻部分的分类与 estimator 标注；剩下多少由展示层自己减，且
    差额必须标成「未分类」而不是某个具体类别——否则就是把估算误差伪装成测量结果。

    缺源事件时给 None（JSON null）而不是 0：「日志里没有 skill-catalog 事件」与
    「发布了一个空目录」是两回事。与 unreported_fields 是同一条纪律。

    「最近一次发布覆盖前一次」——目录与 request/header 都会在会话中途重发
    （模型切换），当前状态是最后那次，不是历次累加。
    """
    # 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    # branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    # 对同一笔钱/同一批行为重复计数（见 util.fork_boundary 的实测数据）。
    events = post_fork(events)
    system = tools = catalog = entries = names = None

    for event in events:
        if not isinstance(event, dict):
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue

        if event.get("type") == "request/header":
            header = data.get("header")
            if isinstance(header, dict):
                if isinstance(header.get("system"), str):
                    system = est_tokens(header["system"])
                if header.get("tools") is not None:
                    # 模型看到的就是这份 JSON —— 分隔符须与 Rust serde_json 一致
                    text = json.dumps(header["tools"], ensure_ascii=False,
                                      separators=(",", ":"))
                    tools = est_tokens(text)
            continue

        # 技能目录挂在多种事件的 data.source 上（不是专用事件类型）
        source = data.get("source")
        if not isinstance(source, dict) or source.get("kind") != "skill-catalog":
            continue
        items = source.get("entries")
        if not isinstance(items, list):
            continue
        total = 0
        this_names = []
        for entry in items:
            name = entry.get("name") or "" if isinstance(entry, dict) else ""
            desc = entry.get("description") or "" if isinstance(entry, dict) else ""
            tokens = est_tokens(f"{name}{desc}")
            total += tokens
            this_names.append({"name": name, "tokens": tokens})
        catalog = total
        entries = len(items)
        names = this_names

    if system is None and tools is None and catalog is None:
        resident_total = None  # 三项全缺时不拿 0 当合计
    else:
        resident_total = (system or 0) + (tools or 0) + (catalog or 0)

    return {
        "system_tokens": system,
        "tools_tokens": tools,
        "catalog_tokens": catalog,
        "catalog_entries": entries,
        "catalog_names": names,
        "resident_total": resident_total,
        # 展示层据此标注「估算」，且不得把它与 provider 的 context_tokens 直接
        # 相减后当作精确的分类结果。
        "estimator": "est_tokens",
    }


def usage_signal_status(usage_events):
    """P3 group②（docs/RUNTIME_EVIDENCE_CONTRACT.md §17，cost fold）：
    `token_by_model`/`request_metrics`/`context_composition`/
    `cost.cost_report` 这族函数依赖同一个信号——"这份日志里有没有 usage
    证据"。**不新造一套裁决逻辑**：这族函数早就有自己的"不编造"纪律
    （零样本时 `by_model` 是 `{}`、`unreported_fields` 是 `[]`、
    `cost_report` 直接返回 `None`），这里只是把它正式挂到 Signal 词汇上，
    给跨规则族的一致性检查用。与 Rust `usage.rs::usage_signal_status`
    逐字节对齐——调用方必须传**分叉之后**的 usage_events（`post_fork` 一次，
    `token_by_model` 自己内部也会再 post_fork 一次，幂等，不重复计数）。
    """
    count = len(usage_events)
    if count == 0:
        return {
            "status": "unavailable",
            "missing": ["Usage"],
            "reason": "no evidence for required signal(s) in this session",
        }
    return {"status": "measured", "sample_count": count}


def _usage_fold_default():
    """可续折叠的空状态（`usage.rs::UsageFoldState` 的 Python 镜像）。

    只携带**跨 turn 延续**的状态；`last` 同 step 去重槽**不在这里**，留在
    `_usage_fold_into` 函数内局部——turn 边界之后第一条 usage 必是新 turn，
    不可能命中前缀最后那条的 (turn, step)（§10.2 契约：「mid-turn 的 checkpoint
    需要序列化替换状态；boundary 处不需要」）。这就是 `usage_fold_resume` 只
    保证在 **turn 边界**切分时与 `token_by_model` 逐字节一致的原因。
    """
    return {
        "by_model": {},
        "providers": {},
        "active": None,
        "sequence": [],
        "seen": set(),      # 真正出现过的 usage 字段名（见 _buckets_from 的注释）
        "samples": 0,       # usage 样本计数——0 个样本时不对「未上报」下任何断言
        "unaccounted": {},  # 残差哨兵：类型 → {count, tokens_seen}（见 usage_shaped_tokens）
    }


def _usage_fold_into(state, events):
    """把一段分叉之后的事件折进 state——`token_by_model` / `usage_fold_checkpoint`
    / `usage_fold_resume` 共用的内层循环。

    `last` 同 step 去重槽是函数内局部量，每次从 None 起：checkpoint 建立时槽
    本为空；resume 的后缀从 turn 边界开始，第一条 usage 必是新 turn，不会命中
    前缀里的槽（§10.2）。**增量折叠绝不另写一条"快路"**——必须与全量重折逐字节
    相同，所以三者共用同一个 `_usage_fold_into`。
    """
    last = None  # (turn, step, buckets, model, peak) —— 同 step 去重槽，不跨调用延续

    for event in events:
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        if etype == "request/header":
            data = event.get("data")
            model = None
            provider = None
            if isinstance(data, dict):
                header = data.get("header")
                if isinstance(header, dict):
                    config = header.get("config")
                    if isinstance(config, dict):
                        model = config.get("model")
                        provider = config.get("provider")
            if not isinstance(model, str):
                continue
            # 供应商与模型是**两个维度**：真实会话里同一份日志既有
            # provider=deepseek-official 的 flash，也有 provider=shengsuanyun 的
            # pro——两家的价目表不同，只按模型名计价会把一家的用量按另一家的价
            # 算（实测把胜算云的 3.5M token 按 DeepSeek 官方价算出了 ¥1.66）。
            #
            # 三种取值必须分开，否则会把「老日志没这个字段」和「两家都服务过
            # 这个模型」混为一谈：
            #   - None       = 所有 header 都没上报 provider（老日志）→ 计价方
            #                  沿用默认表，保持既有行为；
            #   - "…"        = 唯一确定的供应商 → 按白名单判断能不能计价；
            #   - AMBIGUOUS  = 同一模型名被两家服务过 → 我们无法判断哪些 token
            #                  属于哪家，猜一个等于替用户编一次归属，拒绝计价。
            _record_provider(state["providers"], model, provider)
            if state["active"] != model:
                state["sequence"].append(model)
            state["active"] = model
            continue

        data = event.get("data")
        if not isinstance(data, dict):
            continue
        sample = _usage_sample(event, etype, data)
        if sample is None:
            # 残差哨兵：这条事件没被接住，但 payload 里有我们认得的 token
            # 字段 → 记下来。见 `usage_shaped_tokens` 的文档：哨兵只报警，
            # 不计价，归类由人来做。
            seen_tokens = usage_shaped_tokens(data)
            if seen_tokens is not None:
                entry = state["unaccounted"].setdefault(
                    etype if isinstance(etype, str) else "(unknown)",
                    {"count": 0, "tokens_seen": 0})
                entry["count"] += 1
                entry["tokens_seen"] += seen_tokens
            continue
        turn, step, usage, model_override = sample
        state["samples"] += 1
        buckets = _buckets_from(usage, state["seen"])
        if model_override and model_override[0]:
            # 这份样本自带模型归属（目前只有 compaction/summary）——不能
            # 沿用"当前激活模型"，那是给对话轮次用的追踪状态，compaction
            # 走的往往是另一个模型/供应商（真实实测：会话主体 pro/flash
            # 混合，compaction 用的是 deepseek-v4-flash/deepseek-official）。
            model = model_override[0]
            _record_provider(state["providers"], model, model_override[1])
        else:
            model = state["active"] if state["active"] is not None else "unknown"
        peak = _is_peak(event)
        if last is not None and last[0] == turn and last[1] == step:
            if last[2] == buckets and last[4] == peak:
                continue
            _add_buckets(state["by_model"], last[3], last[2], -1, last[4])
            _add_buckets(state["by_model"], model, buckets, 1, peak)
            last = (turn, step, buckets, model, peak)
        else:
            _add_buckets(state["by_model"], model, buckets, 1, peak)
            last = (turn, step, buckets, model, peak)


def usage_fold_checkpoint(events):
    """事件流（分叉之后）→ 可序列化的 checkpoint 状态。

    调用方负责先 `post_fork`：分叉边界只由日志头第一个 `session` 事件的
    `seedLength` 决定（`util.fork_boundary`），对 append-only 日志是一次性
    稳定的，不必每个 checkpoint 重算；而且 resume 时后缀里没有 session 头，
    重算会得到 None（= 不过滤），与「前缀已滤、后缀无分叉事件」一致。
    """
    state = _usage_fold_default()
    _usage_fold_into(state, events)
    return state


def usage_fold_render(state):
    """折叠状态 → `token_by_model` 的输出形状。"""
    # 一个样本都没有时返回空列表：没有数据就不做「执行环境不报这个字段」的断言，
    # 与 harness 能力缺失时「缺列而不是编列」是同一条纪律。
    unreported = [f for f in _SAMPLE_FIELDS if f not in state["seen"]] if state["samples"] else []
    # `unaccounted_usage` 是 `unreported_fields` 的**对偶**：后者说「执行环境
    # 从没报过这个字段」，前者说「执行环境报了 token，但我们没接住」。在证据
    # 模型里它就是 `Signal::Usage` 的 `unmetered` 计数——`evidence.rs` 的
    # 那句注释精确预言了这个 bug：「适配器不能靠"读不到就不算"来偷偷刷高
    # 自己的覆盖率」。按类型名排序保证确定性输出（Rust 侧用 BTreeMap 对齐）。
    unaccounted_usage = [
        {"type": t, "count": v["count"], "tokens_seen": v["tokens_seen"]}
        for t, v in sorted(state["unaccounted"].items())
    ]
    return {"by_model": state["by_model"], "providers": state["providers"],
            "sequence": state["sequence"], "unreported_fields": unreported,
            "unaccounted_usage": unaccounted_usage}


def usage_fold_resume(state, events):
    """checkpoint + 后续事件 → 输出。

    §10.2 契约：`fold(events[0..n]) == fold_resume(checkpoint@k, events[k..n])`
    对任何 **turn 边界** k 成立。`events` 必须是分叉之后、且从 turn 边界开始的
    后缀——mid-turn 切分需要序列化 `last` 替换状态，这个 checkpoint 不携带。

    深拷贝状态再折，不修改调用方的 checkpoint（Rust 侧 `clone` 的镜像）。
    """
    st = dict(state)
    # bucket 值对象也必须复制：`_add_buckets` 是 `cur[key] = ...` 原地改，
    # 只 `dict(by_model)` 浅拷贝会把 checkpoint 的 bucket 一起改掉——那就不是
    # 「checkpoint 是可复用值」而是静默双计了。providers 值是 str/None 不可变，
    # 共享安全，但统一复制保持一致。
    st["by_model"] = {m: dict(b) for m, b in state["by_model"].items()}
    st["providers"] = dict(state["providers"])
    st["sequence"] = list(state["sequence"])
    st["seen"] = set(state["seen"])
    st["unaccounted"] = {t: dict(v) for t, v in state["unaccounted"].items()}
    _usage_fold_into(st, events)
    return usage_fold_render(st)


def usage_fold_checkpoint_json(state):
    """checkpoint 的 JSON 形态（watcher/持久化用），与 Rust
    `usage_fold_checkpoint_json` 逐字节对齐。

    只落跨 turn 状态；`seen` 折成 `_SAMPLE_FIELDS` 顺序的 4 个 bool（Rust 侧
    `[bool; 4]`）；`unaccounted` 每条存 `[count, tokens_seen]` 列表（Rust 侧
    `[u64, i64]`）。`by_model`/`providers`/`sequence` 保插入序，与 serde
    preserve_order 对齐。
    """
    return {
        "by_model": state["by_model"],
        "providers": state["providers"],
        "active": state["active"],
        "sequence": state["sequence"],
        "seen": [f in state["seen"] for f in _SAMPLE_FIELDS],
        "samples": state["samples"],
        "unaccounted": {t: [v["count"], v["tokens_seen"]]
                        for t, v in sorted(state["unaccounted"].items())},
    }


def usage_fold_resume_from_json(value):
    """JSON checkpoint → 折叠状态（`usage_fold_checkpoint_json` 的逆）。"""
    state = _usage_fold_default()
    if not isinstance(value, dict):
        return state
    by_model = value.get("by_model")
    if isinstance(by_model, dict):
        state["by_model"] = dict(by_model)
    providers = value.get("providers")
    if isinstance(providers, dict):
        state["providers"] = dict(providers)
    active = value.get("active")
    if isinstance(active, str):
        state["active"] = active
    sequence = value.get("sequence")
    if isinstance(sequence, list):
        state["sequence"] = [s for s in sequence if isinstance(s, str)]
    seen = value.get("seen")
    if isinstance(seen, list):
        state["seen"] = {f for f, present in zip(_SAMPLE_FIELDS, seen) if present}
    samples = value.get("samples")
    if isinstance(samples, int):
        state["samples"] = samples
    unaccounted = value.get("unaccounted")
    if isinstance(unaccounted, dict):
        for t, v in unaccounted.items():
            if (isinstance(v, list) and len(v) == 2
                    and isinstance(v[0], int) and isinstance(v[1], int)):
                state["unaccounted"][t] = {"count": v[0], "tokens_seen": v[1]}
    return state


def token_by_model(events):
    """事件流 → `{"by_model": {...}, "sequence": [...]}`。

    纯函数、确定性：同一事件流重放结果逐字节一致（与 Rust core 对齐）。
    非 object 条目跳过；request/header 设活跃模型（sequence 相邻去重，保留
    「切回」信息）；assistant/chunk（usage 型）与 assistant/message（带
    usage）折进当前模型；缺 turn/step 或 usage 非 object 的 usage 事件跳过；
    无 request/header 时归 `"unknown"` 桶。

    实现就是 `usage_fold_checkpoint` + `usage_fold_render`：**增量折叠必须与
    全量重折逐字节相同**，所以增量绝不是另一条快路，而是同一个纯函数作用在
    更多事件上（`usage_fold_resume`）。
    """
    # 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    # branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    # 对同一笔钱/同一批行为重复计数（见 util.fork_boundary 的实测数据）。
    events = post_fork(events)
    state = usage_fold_checkpoint(events)
    return usage_fold_render(state)


def token_by_date_model(events, source=SOURCE_UNSPECIFIED):
    """`token_by_model` 的模型维 × `hour_buckets` 的日期维 —— `{date: {model: 八桶}}`。

    单一真相源是 `crates/agent-vitals-domain/src/domain/usage.rs::token_by_date_model`，
    这里是 Python 平行实现，由该文件的
    `token_by_date_model_python_rust_byte_for_byte_parity` 逐字节看守（键序：
    日期升序、模型按首现顺序）。

    **它属于 core 而不是"只给 Python 状态层用的辅助函数"**：日历（按天）和
    DSH 审计（按 session）是同一个审计能力的两个投影，同月 token 总数与成本
    必须相等；按天这一维一旦掉出双实现差分，两个投影就能各自漂移而无人发现
    （真实事故：日历报 ¥2386，按 session 重算是 ¥1733）。状态栏后续接
    Rust-Tauri 也要用同一份折叠，不能是 Python 私有的第二套。

    **为什么 `token_by_model` 本身不够**：它按模型累加整个 session 的用量，
    完全不留时间戳；一个跨零点的 session 被喂进 `merge_month` 时,过去唯一的
    办法是把 by_model 整体归到调用方那一天（`_today_key()`）——这在「回填历史
    日志」场景下会把钱记错日子（真实 case：`session-e4b0be69` 横跨 4 天，
    整段 by_model 被记成回填当天,月度精算成本因此漏记了未落到该日的部分）。

    这里改成**逐事件**判日期（复用 `_hour_key`，与 `hour_buckets` 同一条时区
    规则），跨午夜的 session 天然按各自 `event.time` 分到正确的日期，不需要
    对同一个 session 是否跨天做特殊判断。去重语义（同 (turn, step) 先扣旧
    归属再加新归属）与 `token_by_model` 逐字节一致——否则这份数据与
    `token_by_model`/`hour_buckets` 的「总和必须相等」不变量就会各算各的。

    时间戳缺失的样本不产生日期桶（与 `hour_buckets` 同一条纪律：未知时间
    不能算进任何一天，否则会被 1970-01-01 污染或凭空当成「今天」）。

    **`source`（per-source 拆账）**：一次调用喂入的整批事件标一个来源，由
    **调用方显式标注**——oneline/calendar 重跑同一批会话是 2026-08「日历
    ¥2386 vs 按 session 重算 ¥1733」事故的 (a) 根，没有来源轴就永远看不出
    「同一批被喂了几次」。输出里多一个 `by_source` 键（`{date: {source:
    {model: 八桶}}}`），与主输出**同一次循环**累计、同 (turn, step) 去重
    （扣旧加新都落在同一个 source 键上），保证 by_source 各 source 之和 ==
    主输出总量。`by_source` 只在有带日期样本时出现（无样本输出仍是 `{}`），
    插在**最后**——无 by_source 读方的键序不受影响。
    """
    events = post_fork(events)
    by_date_model = {}
    by_source = {}
    active = None
    last = None  # (turn, step, date, model, buckets, peak)

    def fold(date_str, model, buckets, peak, sign):
        if date_str is None:
            return
        day = by_date_model.setdefault(date_str, {})
        cur = day.setdefault(model, dict(_EMPTY_BUCKET))
        for k in _BASE_KEYS:
            cur[k] = cur[k] + sign * buckets[k]
        if peak:
            for base_key, peak_key in zip(_BASE_KEYS, _PEAK_KEYS):
                cur[peak_key] = cur[peak_key] + sign * buckets[base_key]

    def fold_source(date_str, model, buckets, peak, sign):
        # 同一份贡献记进 source 桶。只记带日期的样本——主输出对无时间戳样本
        # 本来就不产生日期桶，source 轴与它保持同一口径。
        if date_str is None:
            return
        src_day = by_source.setdefault(date_str, {})
        cur = src_day.setdefault(source, {}).setdefault(model, dict(_EMPTY_BUCKET))
        for k in _BASE_KEYS:
            cur[k] = cur[k] + sign * buckets[k]
        if peak:
            for base_key, peak_key in zip(_BASE_KEYS, _PEAK_KEYS):
                cur[peak_key] = cur[peak_key] + sign * buckets[base_key]

    for event in events:
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        if etype == "request/header":
            data = event.get("data")
            model = None
            if isinstance(data, dict):
                header = data.get("header")
                if isinstance(header, dict):
                    config = header.get("config")
                    if isinstance(config, dict):
                        model = config.get("model")
            if isinstance(model, str):
                active = model
            continue
        if not isinstance(event.get("data"), dict):
            continue
        sample = _usage_sample(event, etype, event["data"])
        if sample is None:
            continue
        turn, step, usage, model_override = sample
        buckets = _buckets_from(usage, set())
        time_ms = _int_or_none(event.get("time"))
        date_str = _hour_key(time_ms)[0] if time_ms is not None else None
        peak = _is_peak(event) if time_ms is not None else None
        # 同 token_by_model：自带模型归属的样本（目前只有 compaction/summary）
        # 不沿用"当前激活模型"。
        model = (model_override[0] if model_override and model_override[0]
                 else (active if active is not None else "unknown"))

        if last is not None and last[0] == turn and last[1] == step:
            # 扣旧加新在主输出与 source 桶**同步**做——一次调用只喂一个 source，
            # 净结果等于新值，两个轴都不会翻倍。
            fold(last[2], last[3], last[4], last[5], -1)
            fold_source(last[2], last[3], last[4], last[5], -1)
            fold(date_str, model, buckets, peak, 1)
            fold_source(date_str, model, buckets, peak, 1)
        else:
            fold(date_str, model, buckets, peak, 1)
            fold_source(date_str, model, buckets, peak, 1)
        last = (turn, step, date_str, model, buckets, peak)

    # 只在有带日期样本时插 by_source 键——无样本/全无时间戳时输出仍是空对象
    # `{}`，不摆一个空 source 结构出来冒充「测到了什么」。
    if by_source:
        by_date_model["by_source"] = by_source
    return by_date_model


def _hour_key(time_ms):
    """time_ms → (date_str, hour) in Asia/Shanghai。

    纯整数算 + `date(1970,1,1) + timedelta` 拼出 ISO 日期，避开本地时区陷阱：
    `datetime.fromtimestamp` 会按 **本地** 时区算，机器在 UTC+0 跑就把 14 点
    写成 06 点——日历直接错一天。**整差 = 北京时间天数**（已加 8 小时偏移），
    用 timedelta 推进到日期对象，跨时区一致。

    `secs % 86400 // 3600` 是北京时间的小时数（0–23）。
    """
    secs = time_ms // 1000 + _BEIJING_OFFSET_SECS
    days = secs // 86400
    d = _EPOCH_DATE + timedelta(days=days)
    return d.isoformat(), (secs % 86400) // 3600


def _fold_hour_bucket(buckets_map, time_ms, add_buckets, peak, sign):
    """按 (date, hour) 累加/扣除一份 4 桶贡献。`sign=-1` 用于同 (turn, step)
    去重时回滚旧值——见 `token_by_model` 的同 step 替换语义，那边怎么写这边
    怎么写，否则两边的逐请求 vs 逐小时会出现不可解释的偏差。

    time_ms 缺场时落进 ("unknown", None) 这一个特殊键——保留数据但**不让它
    混进实际时间桶**，否则下游做「过去 7 天合计」会把时间戳缺失的样本算成
    1970-01-01。`is_peak` 同步置 None（缺 time ≠ 在空闲时段，与 `_is_peak`
    的保守 fallback 是同一条纪律：未测到不如实给空）。
    """
    if time_ms is None:
        key = (None, None)
        bucket_peak = None
    else:
        key = _hour_key(time_ms)
        bucket_peak = peak
    cur = buckets_map.setdefault(key, dict(_EMPTY_BUCKET))
    for k in _BASE_KEYS:
        cur[k] = cur[k] + sign * add_buckets[k]
    if bucket_peak:
        for base_key, peak_key in zip(_BASE_KEYS, _PEAK_KEYS):
            cur[peak_key] = cur[peak_key] + sign * add_buckets[base_key]


def hour_buckets(events):
    """事件流 → 按 (date, hour) 折叠到 token 桶。Rust 平行实现见
    `crates/agent-vitals-domain/src/domain/usage.rs::hour_buckets`。

    与 `token_by_model` 是**同一次 fold 的第三个出口**：那边按模型折、
    `request_metrics` 按请求点折、这里按小时折。共用 `_usage_sample` +
    `_buckets_from` + `_is_peak`，三处去重/peak 语义必须一致——任何一处
    改了去重而另两处没改，三方对账立刻红。

    不变量（测试钉死）：
    - 全桶 4+4 字段之和 == `token_by_model` 按模型聚合后求和（按同一份 events）；
    - (date, hour) 是**去重后**的聚合粒度，不受 chunk/message 顺序影响；
    - 跨午夜事件按各自 `event.time` 归属，不归到 session 开始那天——
      真实日志单会话跨 23:50→00:10 时归属各自时间，不是「session 那天」；
    - 时间戳缺失的样本落 `("unknown", None)` 桶，**不**进入日历。

    输出结构：
        {
          "buckets": [
            {"date": "2026-08-25", "hour": 14, "is_peak": true,
             "uncached_input_tokens": ..., ..., "peak_uncached_input_tokens": ...},
            ...
          ],
          "schema_version": 1,
          "tz_name": "Asia/Shanghai (UTC+8 fixed, no DST)",
          "tz_offset_hours": 8,
          "unreported_fields": [...],
        }

    `is_peak` 在每条 bucket 上保留而不是从外部用 date+hour 重算——
    让调用方决定怎么画日历（颜色条/阈值提示线）时不必重新实现一遍
    北京时间规则（与 `request_metrics` 的 `is_peak` 列是同一条设计）。
    """
    # 只看分叉之后的事件——见 token_by_model 的同条注释
    events = post_fork(events)
    buckets_map = {}  # (date_str, hour) → bucket dict
    last = None  # (turn, step, time_ms, add_buckets, peak) —— 同 step 去重槽
    seen_fields = set()
    samples = 0

    for event in events:
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        # request/header 在这里**只用于触发 _usage_sample 的提取路径**——
        # hour_bucket 不按模型分桶，但跳过 header 会让去重槽丢失上下文
        # （chunk/message 之前必须有 header 才能识别 active model），与
        # token_by_model 行为对齐
        if etype == "request/header":
            continue
        if not isinstance(event.get("data"), dict):
            continue
        sample = _usage_sample(event, etype, event["data"])
        if sample is None:
            continue
        turn, step, usage, _model_override = sample  # hour_buckets 不按模型分桶
        samples += 1
        add_buckets = _buckets_from(usage, seen_fields)
        time_ms = _int_or_none(event.get("time"))
        peak = _is_peak(event) if time_ms is not None else None

        if last is not None and last[0] == turn and last[1] == step:
            # 同 step：先扣掉旧归属，再把新归属加到当前 hour 桶
            _fold_hour_bucket(buckets_map, last[2], last[3], last[4], -1)
            _fold_hour_bucket(buckets_map, time_ms, add_buckets, peak, 1)
            last = (turn, step, time_ms, add_buckets, peak)
        else:
            _fold_hour_bucket(buckets_map, time_ms, add_buckets, peak, 1)
            last = (turn, step, time_ms, add_buckets, peak)

    # 展平成列表 + 按 (date, hour) 排序 + 每条带上 is_peak 标签
    # 时间缺失的桶 (date=None, hour=None) 一律沉到最后；calendar 渲染时再过滤掉它们
    rows = []
    for (date_str, hour), b in buckets_map.items():
        if date_str is None:
            is_peak = None
        else:
            sample_peak = b["peak_uncached_input_tokens"] or b["peak_output_tokens"] \
                or b["peak_cache_read_tokens"] or b["peak_cache_write_tokens"]
            is_peak = bool(sample_peak)
        rows.append({"date": date_str, "hour": hour, "is_peak": is_peak, **b})
    rows.sort(key=lambda r: (
        r["date"] is None,  # 缺时间的桶沉底
        r["date"],
        r["hour"] if r["hour"] is not None else -1,
    ))

    unreported = [f for f in _SAMPLE_FIELDS if f not in seen_fields] if samples else []
    return {
        "buckets": rows,
        "schema_version": 1,
        "tz_name": "Asia/Shanghai (UTC+8 fixed, no DST)",
        "tz_offset_hours": 8,
        "unreported_fields": unreported,
    }


def pre_fork_usage(events):
    """分叉前那段被排除掉的用量——**只为把话说清楚而存在**。

    主输出已经把分叉前的事件滤掉了（审计回答的是「这个会话干了什么」），但金额
    会因此显著变小（实测 ¥1113.66 → ¥433.30）。不给出被排除的量，用户会以为
    数据坏了。

    返回 None 表示这个会话根本没有分叉——不是返回一个全零的结构，「没分叉」和
    「分叉了但上游没花钱」是两回事。

    Rust 平行实现见 `crates/agent-vitals-domain/src/domain/usage.rs::pre_fork_usage`。
    """
    from ..util import fork_boundary
    b = fork_boundary(events)
    if b is None:
        return None
    before = [e for e in events if isinstance(e.get("seq"), int) and e["seq"] < b]
    if not before:
        return None
    # 不能直接调 token_by_model —— 它自己会先 post_fork 把这批全滤掉。
    # 追加一个哨兵边界，让内部的 post_fork 认为「分叉在最开头」，从而全量保留。
    out = token_by_model([{"type": "session/end-seed", "seq": -1, "data": {}}] + before)
    out["boundary_seq"] = b
    return out


# ==== canonical 归一层（吸收项 #1）=========================================
#
# per-source 拆账（by_source 轴）的缺口：它只认 DSH 形状的 4 桶，Codex 是独立
# 管线（codex_fold_file，5 桶 + speed 维），两种线格式永远进不了同一张表。
# canonical 层在折叠之上再加一层归一：把各来源自己折好的桶映射成统一维
# （FRESH/TOTAL/…）。单一真相源是 `crates/agent-vitals-domain/src/domain/usage.rs` 的
# canonical 段——那里有一份完整的中文注释讲**为什么必须建在折叠之上**（窄出
# 权威 vs 宽进哨兵，两条路径一旦合并，同一笔用量在多个事件里重复出现时会被
# 双计）。这里是它的逐字节镜像，由 Rust 侧的
# `canonical_tokens_python_rust_byte_for_byte_parity`（硬编码串）与
# `tests/test_canonical_cost.py` 双向锁死。

#: canonical 层的统一维清单（`unavailable` 的取值空间）。顺序固定，与 Rust 侧
#: `usage.rs::CANONICAL_DIMS` 逐字节对齐。
CANONICAL_DIMS = [
    "fresh_input_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "legacy_total_tokens",
]

SHAPE_DSH = "dsh"
SHAPE_CODEX = "codex"
SHAPE_CODEX_TOTAL = "codex-total"
SHAPE_UNKNOWN = "unknown"


def _canonical_row(source, shape, fresh, total, cache_read, cache_write,
                   reasoning, legacy_total):
    """组装一行 canonical 输出。值全为 int|None——None 落 null 且进 unavailable，
    绝不落 0。unavailable 顺序 = CANONICAL_DIMS 顺序（确定性，与 Rust 侧
    `usage.rs::canonical_row` 逐字节对齐）。

    naive 是把 None 落 0 再拼一个空 unavailable 列表——那会把「执行环境没报这个
    字段」编造成「测到 0」，正是 `unreported_fields` 当初要修的缺陷。
    """
    vals = [fresh, total, cache_read, cache_write, reasoning, legacy_total]
    row = {"source": source, "shape": shape}
    unavailable = []
    for dim, v in zip(CANONICAL_DIMS, vals):
        if v is None:
            row[dim] = None
            unavailable.append(dim)
        else:
            row[dim] = v
    row["unavailable"] = unavailable
    return row


def canonical_from_dsh(events, source):
    """DSH 形状 → canonical 行。复用 `token_by_model`（已经做完 post_fork、同
    (turn, step) 去重、unreported_fields 收集）——canonical 只归一，不重折。

    DSH 4 桶：inputTokens(=uncached 全价)、outputTokens（reasoning 已含在 output）、
    cacheReadTokens、cacheWriteTokens。FRESH = input、TOTAL = input + output +
    cacheRead + cacheWrite。`unreported_fields` 决定哪几维落 null——naive 是
    把缺字段按 0 求和完事，那正是 UI 曾经显示「缓存写 0」一个伪造测量值的形态。
    """
    tm = token_by_model(events)
    by_model = tm.get("by_model") or {}
    fresh = output = cache_read = cache_write = 0
    for m in by_model.values():
        fresh += m.get("uncached_input_tokens") or 0
        output += m.get("output_tokens") or 0
        cache_read += m.get("cache_read_tokens") or 0
        cache_write += m.get("cache_write_tokens") or 0
    if not by_model:
        # 整批没有 usage 样本 → 全部维 null + 全量 unavailable（不是测到 0）。
        return _canonical_row(source, SHAPE_DSH, None, None, None, None, None, None)
    unreported = set(tm.get("unreported_fields") or [])
    fresh_v = fresh if "inputTokens" not in unreported else None
    total_v = (fresh + output + cache_read + cache_write
               if "inputTokens" not in unreported and "outputTokens" not in unreported
               else None)
    cache_read_v = cache_read if "cacheReadTokens" not in unreported else None
    cache_write_v = cache_write if "cacheWriteTokens" not in unreported else None
    # DSH schema 没有 reasoning 维（含在 output 里）→ 恒 null + unavailable。
    return _canonical_row(source, SHAPE_DSH, fresh_v, total_v, cache_read_v,
                          cache_write_v, None, None)


def canonical_from_codex(events, source):
    """Codex 形状 → canonical 行。复用 `codex_fold_file`（读完 last_token_usage
    的 per-turn delta，无效样本已进 unaccounted）——canonical 只归一。

    Codex 5 桶：uncached/output/cached/cache_write/reasoning，其中 cached +
    cache_write 已经是 input 的一部分（wire 的 input_tokens 是总 input，
    uncached = input − cached − cache_write）。所以 TOTAL = input + output =
    uncached + output + cached + cache_write（reasoning 在 output 里不另加）；
    FRESH = uncached（全价 input）；cache_read 映射到 cached_input。

    延迟 import：codex_usage 与 usage 没有环（它只依赖 datetime），但按
    `pre_fork_usage` 的既有模式在函数体内 import，避免任何 import 序的脆性。
    """
    from .codex_usage import codex_fold_file

    fold = codex_fold_file(events)
    by_model = fold.get("by_model") or {}
    fresh = output = cached = cache_write = reasoning = 0
    any_ = False
    for speeds in by_model.values():
        if not isinstance(speeds, dict):
            continue
        for bucket in speeds.values():
            any_ = True
            fresh += bucket.get("uncached_input_tokens") or 0
            output += bucket.get("output_tokens") or 0
            cached += bucket.get("cached_input_tokens") or 0
            cache_write += bucket.get("cache_write_input_tokens") or 0
            reasoning += bucket.get("reasoning_output_tokens") or 0
    if not any_:
        return _canonical_row(source, SHAPE_CODEX, None, None, None, None, None, None)
    # 5 桶来自同一份 last_token_usage，codex_token_facts 已保证 uncached>=0、
    # reasoning<=output —— 没有「某维没测到」的中间态，unavailable 为空。
    return _canonical_row(source, SHAPE_CODEX, fresh, fresh + output + cached + cache_write,
                          cached, cache_write, reasoning, None)


def canonical_total_delta(prev, cur, source):
    """Codex `total_token_usage`（每 item 的累计快照）→ canonical 行。prev/cur
    都是 total_token_usage 对象（caller 负责从 payload.info.total_token_usage
    提取），本函数只做差分，不碰事件流。

    delta 语义（为什么 naive 直接拿 cur 当增量是错的——cc-trace over-read 教训、
    codex_fold_file 的 continuous-dedup 同一条铁律）：
      - prev 为 None：第一条累计快照，没有基线算不出 delta → fresh/total 为
        null + unavailable，但 legacy_total_tokens 放 raw 累计值（「只有老格式
        才带的字段」放 legacy 槽，绝不把总量拆成编造的四桶）。
      - prev 与 cur 签名相同：同一计量复读 → delta 全 0（测到 0，不是没测到）。
      - 任一 delta < 0：累计回退 → 不产负数，fresh/total null + unavailable，
        raw 累计照放。
      - 其余：逐字段差分，uncached 从 delta 派生（d_input − d_cached − d_cw）。
    """
    from .codex_usage import _total_signature

    legacy = cur.get("total_tokens") if isinstance(cur, dict) else None
    cur_sig = _total_signature(cur)
    if cur_sig is None:
        return _canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy)
    prev_sig = _total_signature(prev) if isinstance(prev, dict) else None
    if prev_sig is None:
        return _canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy)
    if cur_sig == prev_sig:
        return _canonical_row(source, SHAPE_CODEX_TOTAL, 0, 0, 0, 0, 0, legacy)
    d = [cur_sig[i] - prev_sig[i] for i in range(5)]
    if any(x < 0 for x in d):
        return _canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy)
    d_uncached = d[0] - d[2] - d[3]
    if d_uncached < 0:
        return _canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy)
    # TOTAL = d_input + d_output = uncached + output + cached + cache_write。
    return _canonical_row(source, SHAPE_CODEX_TOTAL, d_uncached,
                          d_uncached + d[1] + d[2] + d[3], d[2], d[3], d[4], legacy)


def canonical_tokens(events, source=SOURCE_UNSPECIFIED):
    """canonical 归一主入口：`(events, source)` → 一行统一 canonical 计数。

    来源标签声明 shape（走哪张翻译表）：dsh-live / dsh-backfill / cli /
    unspecified → dsh；codex → codex。未知来源标签 → shape=unknown、全维
    unavailable——不摆全零结构冒充「测到了什么」（诚实降级）。

    调查结论（#4，带证据）：Codex 事件现在并不进 `token_by_date_model`。生产
    调用点只有 oneline 两条（Rust `src/agent/oneline.rs` 与 Python
    `cli.py:1401`，都标 SOURCE_CLI、喂 DSH 形状 usage_events）；Codex 走完全
    独立的管线（codex_fold_file → codex_aggregate_hours → codex_cost），
    `adapters/codex_session.py` 保持 Codex item 原样、任何一层都没有预翻译成
    DSH 形状。canonical 层建好后的接法就是本函数：DSH 事件喂 dsh 形状、Codex
    事件喂 codex 形状，各自归一成同一行——#6 事件桥在此基础上做跨源合并。
    """
    if source in (SOURCE_DSH_LIVE, SOURCE_DSH_BACKFILL, SOURCE_CLI, SOURCE_UNSPECIFIED):
        return canonical_from_dsh(events, source)
    if source == SOURCE_CODEX:
        return canonical_from_codex(events, source)
    return _canonical_row(source, SHAPE_UNKNOWN, None, None, None, None, None, None)
