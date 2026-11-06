"""generic 插件执行环境 recipe 提取（HARNESS_MANIFEST_DSL_SPEC §4）。

`agent_vitals_harnesses::harnesses::generic::recipe` 的 Python twin——三态判定、
token 桶算术、canonical event key（UTF-8 字节长前缀）逐字对齐。

两语言分歧的头号坑（fixtures 已钉，Rust 侧见 recipe.rs 同名测试）：
- **bool 不是整数**：Python `isinstance(True, int)` 为真，必须显式排除；
- **>u64 的整数字面量**：serde_json 解析成 f64（Rust 拒绝），`json.loads`
  给精确 int（naive twin 会接受）——本 twin 必须同样按越界拒绝；
- 浮点 token 两语言都拒绝；
- canonical event key 的字符串长度是 UTF-8 **字节数**（`len(s.encode())`），
  不是码点数。
"""

from .claude_evidence import parse_iso
from .generic_manifest import PluginManifest

# 与 Rust `Slot` 一一对应（字符串即 manifest 词表）。
SLOT_EVENT_TS = "event_ts"
SLOT_MODEL_RAW = "model_raw"
SLOT_PROVIDER_RAW = "provider_raw"
SLOT_UNCACHED_INPUT = "uncached_input_tokens"
SLOT_TOTAL_INPUT = "total_input_tokens"
SLOT_CACHE_READ = "cache_read_tokens"
SLOT_CACHE_WRITE = "cache_write_tokens"
SLOT_OUTPUT = "output_tokens"
SLOT_PROVIDER_REQUEST_ID = "provider_request_id"

ANTHROPIC_DEFAULTS = (
    (SLOT_EVENT_TS, "timestamp"),
    (SLOT_MODEL_RAW, "model"),
    (SLOT_UNCACHED_INPUT, "usage.input_tokens"),
    (SLOT_CACHE_READ, "usage.cache_read_input_tokens"),
    (SLOT_CACHE_WRITE, "usage.cache_creation_input_tokens"),
    (SLOT_OUTPUT, "usage.output_tokens"),
)

TOTAL_INPUT_DEFAULTS = (
    (SLOT_EVENT_TS, "timestamp"),
    (SLOT_MODEL_RAW, "model"),
    (SLOT_TOTAL_INPUT, "usage.prompt_tokens"),
    (SLOT_CACHE_READ, "usage.cache_read_input_tokens"),
    (SLOT_OUTPUT, "usage.output_tokens"),
)

FOUR_BUCKET_DEFAULTS = (
    (SLOT_EVENT_TS, "timestamp"),
    (SLOT_MODEL_RAW, "model"),
    (SLOT_UNCACHED_INPUT, "usage.input_tokens"),
    (SLOT_CACHE_READ, "usage.cache_read_tokens"),
    (SLOT_CACHE_WRITE, "usage.cache_write_tokens"),
    (SLOT_OUTPUT, "usage.output_tokens"),
)

ALL_SLOTS = (
    SLOT_EVENT_TS, SLOT_MODEL_RAW, SLOT_PROVIDER_RAW, SLOT_UNCACHED_INPUT,
    SLOT_TOTAL_INPUT, SLOT_CACHE_READ, SLOT_CACHE_WRITE, SLOT_OUTPUT,
    SLOT_PROVIDER_REQUEST_ID,
)

I64_MAX = 2 ** 63 - 1
U64_MAX = 2 ** 64 - 1


class RecipeDef(object):
    def __init__(self, id_, main_slot, defaults, semantics, observation_kind,
                 subtract_cache_read_from_main):
        self.id = id_
        self.main_slot = main_slot
        self.defaults = defaults
        self.overridable = ALL_SLOTS
        self.source_usage_semantics = semantics
        self.observation_kind = observation_kind
        self.subtract_cache_read_from_main = subtract_cache_read_from_main


_RECIPES = {
    "request-usage-anthropic-v1": RecipeDef(
        "request-usage-anthropic-v1", SLOT_UNCACHED_INPUT, ANTHROPIC_DEFAULTS,
        "delta", "token_count", False),
    "request-usage-openai-total-input-v1": RecipeDef(
        "request-usage-openai-total-input-v1", SLOT_TOTAL_INPUT,
        TOTAL_INPUT_DEFAULTS, "delta", "token_count", True),
    "request-usage-four-bucket-v1": RecipeDef(
        "request-usage-four-bucket-v1", SLOT_UNCACHED_INPUT,
        FOUR_BUCKET_DEFAULTS, "delta", "token_count", False),
}


def recipe_def(recipe_id):
    return _RECIPES.get(recipe_id)


class LineVerdict(object):
    """三态：("emit", candidate) / ("skip", reason) / ("invalid", code, excerpt)。"""

    @staticmethod
    def emit(candidate):
        return ("emit", candidate)

    @staticmethod
    def skip(reason):
        return ("skip", reason)

    @staticmethod
    def invalid(code, excerpt):
        return ("invalid", code, excerpt)


def check_overrides(defn, manifest):
    for key in manifest.overrides.keys():
        if key not in ALL_SLOTS:
            return "overrides.%s: 未知槽位" % key
        if key not in defn.overridable:
            return "overrides.%s: recipe `%s` 不允许覆写该槽位" % (key, defn.id)
    return None


def effective_path(defn, manifest, slot):
    if slot in manifest.overrides:
        return manifest.overrides[slot]
    for s, p in defn.defaults:
        if s == slot:
            return p
    return ""


def dotted_get(record, path):
    """点路径取值：缺失/空路径 → None（与 Rust 短路语义一致——空路径不吃
    记录里的 "" 键）。"""
    if path == "":
        return None
    cur = record
    for seg in path.split("."):
        if isinstance(cur, dict) and seg in cur:
            cur = cur[seg]
        else:
            return None
    return cur


def _token_value(v):
    """→ ("ok", value_or_None) / ("bad", None)。bool 永远不是整数；float 拒绝；
    >i64 的精确 int（Python 特有路径）按越界拒绝——与 serde_json 的 f64 回落
    拒绝对齐（fixtures 钉死）。"""
    if v is None:
        return ("ok", None)
    if isinstance(v, bool):
        return ("bad", None)
    if isinstance(v, int):
        if -2 ** 63 <= v <= I64_MAX:
            return ("ok", v)
        return ("bad", None)
    return ("bad", None)


def canonical_event_key(manifest, record):
    """类型标记 + UTF-8 字节长前缀 + paths 固定顺序。任一路径缺失/null/
    浮点/容器 → None（调用方判 invalid）。"""
    out = []
    for path in manifest.event_key_paths:
        v = dotted_get(record, path)
        if isinstance(v, str):
            b = v.encode("utf-8")
            out.append("s%d:%s;" % (len(b), v))
        elif isinstance(v, bool):
            out.append("b1:%s;" % ("1" if v else "0"))
        elif isinstance(v, int):
            d = str(v)
            out.append("i%d:%s;" % (len(d), d))
        else:
            return None
    return "".join(out)


def truncate_excerpt(record_json_text):
    return record_json_text[:120]


def extract_line(defn, manifest, record):
    """单行提取主入口（§4.3 三态）。判据与 Rust `extract_line` 同序。"""

    def invalid(code):
        return LineVerdict.invalid(code, truncate_excerpt(_dumps(record)))

    # discriminator：主数量槽位有效路径的父容器是 dict。
    main_path = effective_path(defn, manifest, defn.main_slot)
    if "." in main_path:
        parent_path = main_path.rsplit(".", 1)[0]
        parent = dotted_get(record, parent_path)
    else:
        parent_path = ""
        parent = record
    if not isinstance(parent, dict):
        return LineVerdict.skip("not_target_record")

    # required-shape：主数量。
    main_raw = dotted_get(record, main_path)
    status, main_qty = _token_value(main_raw)
    if status == "bad":
        return invalid("type_mismatch" if isinstance(main_raw, bool)
                       else "token_type_mismatch")
    if main_qty is None:
        return invalid("required_field_missing")
    if main_qty < 0:
        return invalid("negative_token_count")

    # event_ts：字符串 + 显式 offset（复用 claude_evidence.parse_iso twin）。
    ts_raw = dotted_get(record, effective_path(defn, manifest, SLOT_EVENT_TS))
    if not isinstance(ts_raw, str):
        return invalid("required_field_missing" if ts_raw is None else "type_mismatch")
    parsed = parse_iso(ts_raw)
    if parsed is None:
        return invalid("bad_timestamp")
    secs, explicit = parsed
    if not explicit:
        return invalid("timestamp_without_offset")
    if int(ts_raw[17:19]) > 59:
        return invalid("leap_second_timestamp")

    # model_raw：非空字符串。
    model_raw = dotted_get(record, effective_path(defn, manifest, SLOT_MODEL_RAW))
    if not isinstance(model_raw, str) or model_raw == "":
        return invalid("required_field_missing")

    # 其余 token 桶：可选，给了就必须合法非负。
    buckets = {SLOT_UNCACHED_INPUT: None, SLOT_CACHE_READ: None,
               SLOT_CACHE_WRITE: None, SLOT_OUTPUT: None}
    for slot in buckets.keys():
        path = effective_path(defn, manifest, slot)
        if path == "":
            continue
        raw = dotted_get(record, path)
        if raw is None:
            continue
        status, n = _token_value(raw)
        if status == "bad":
            return invalid("type_mismatch" if isinstance(raw, bool)
                           else "token_type_mismatch")
        if n < 0:
            return invalid("negative_token_count")
        buckets[slot] = n

    # 算术：openai-total-input 受控减法。
    cache_read = buckets[SLOT_CACHE_READ]
    if defn.main_slot == SLOT_TOTAL_INPUT:
        diff = main_qty - (cache_read if cache_read is not None else 0)
        if diff < 0:
            return invalid("arithmetic_negative")
        uncached = diff
    else:
        uncached = buckets[SLOT_UNCACHED_INPUT]

    source_event_id = canonical_event_key(manifest, record)
    if source_event_id is None:
        return invalid("event_key_missing")

    provider_raw = dotted_get(record, effective_path(defn, manifest, SLOT_PROVIDER_RAW))
    provider_raw = provider_raw if isinstance(provider_raw, str) and provider_raw else None
    provider_request_id = dotted_get(
        record, effective_path(defn, manifest, SLOT_PROVIDER_REQUEST_ID))
    provider_request_id = (provider_request_id
                           if isinstance(provider_request_id, str) and provider_request_id
                           else None)

    return LineVerdict.emit({
        "event_ts_utc_ms": secs * 1000,
        "source_event_id": source_event_id,
        "model_raw": model_raw,
        "provider_raw": provider_raw,
        "uncached_input_tokens": uncached,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": buckets[SLOT_CACHE_WRITE],
        "output_tokens": buckets[SLOT_OUTPUT],
        "provider_request_id": provider_request_id,
    })


def _dumps(record):
    import json
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


def glob_match(pattern, path):
    """受限 glob（与 Rust `glob_match` 同语义）：`**` 跨层，`*`/`?` 不跨 `/`。"""
    pat = pattern.split("/")
    seg = path.split("/")

    def match_segments(p, s):
        if not p:
            return not s
        if p[0] == "**":
            return any(match_segments(p[1:], s[i:]) for i in range(len(s) + 1))
        if not s:
            return False
        return _glob_star(p[0], s[0]) and match_segments(p[1:], s[1:])

    return match_segments(pat, seg)


def _glob_star(pattern, text):
    pc, tc = pattern[:1], text[:1]
    if pc == "" or tc == "":
        return pattern == "" and text == ""
    if pc == "*":
        return any(_glob_star(pattern[1:], text[i:]) for i in range(len(text) + 1))
    if pc == "?":
        return _glob_star(pattern[1:], text[1:])
    if pc == tc:
        return _glob_star(pattern[1:], text[1:])
    return False
