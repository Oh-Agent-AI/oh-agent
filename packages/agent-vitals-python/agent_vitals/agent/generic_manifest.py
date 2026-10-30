"""generic 插件执行环境 manifest 解析（HARNESS_MANIFEST_DSL_SPEC §3）。

`agent_vitals_harnesses::harnesses::generic::manifest` 的 Python twin——错误串、
校验顺序、词表逐字对齐（golden parity 契约）。改动任何一侧必须同步另一侧
并补两侧 fixtures；受限正则子集是显式扫描，不能依赖各自 re 引擎的失败模式
（Python re 支持 lookahead 而 Rust regex 不支持——这里是两语言分歧的头号源）。
"""

import hashlib
import re as _re

from agent_vitals import __version__

MANIFEST_VERSION = 1
FEATURE_IDS = ()
APP_VERSION = __version__


def _release_version(value):
    if not isinstance(value, str) or not _re.fullmatch(
            r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value):
        return None
    # Bound before int conversion, including Python's large-integer string limit.
    parts = value.split(".")
    if any(len(p) > 10 or (len(p) == 10 and p > "4294967295") for p in parts):
        return None
    return tuple(int(p) for p in parts)


class CapabilitySet(object):
    def __init__(self, app_version=None, recipes=None, features=None):
        self.app_version = APP_VERSION if app_version is None else app_version
        self.recipes = RECIPE_IDS if recipes is None else tuple(recipes)
        self.features = FEATURE_IDS if features is None else tuple(features)


def negotiate_capabilities(value, capabilities=None):
    capabilities = CapabilitySet() if capabilities is None else capabilities
    _negotiate_requirements(value, capabilities)
    if "recipe" in value:
        recipe = value["recipe"]
        if not isinstance(recipe, str):
            raise _err("recipe", "必须是字符串")
        if recipe not in capabilities.recipes:
            raise _err("recipe", "未知 recipe `%s`（已知：%s）"
                       % (recipe, _rust_debug_list(capabilities.recipes)))


def _negotiate_requirements(value, capabilities):
    if not isinstance(value, dict):
        raise _err("(root)", "manifest 必须是 JSON object")
    if "min_app_version" in value:
        minimum = _release_version(value["min_app_version"])
        if minimum is None:
            raise _err("min_app_version", "必须是 MAJOR.MINOR.PATCH（无前导零、预发布或构建后缀，各段 <= 4294967295）")
        current = _release_version(capabilities.app_version)
        if current is None:
            raise _err("min_app_version", "运行时版本不是受支持的发布版本")
        if current < minimum:
            raise _err("min_app_version", "需要 app >= %s（当前 %s）——请升级 app"
                       % (value["min_app_version"], capabilities.app_version))
    if "requires" in value:
        requires = value["requires"]
        if not isinstance(requires, dict):
            raise _err("requires", "必须是 object")
        for key in requires:
            if key not in ("recipes", "features"):
                raise _err("requires.%s" % key, "未知字段")
        for key, supported in (("recipes", capabilities.recipes), ("features", capabilities.features)):
            if key not in requires:
                continue
            field = "requires.%s" % key
            entries = _string_array(requires[key], field, 0, 64)
            for i, entry in enumerate(entries):
                if entry in entries[:i]:
                    raise _err("%s[%d]" % (field, i), "重复能力")
                if entry not in supported:
                    raise _err("%s[%d]" % (field, i),
                               "缺失能力 `%s`（支持：%s；最低版本未知）——请升级 app 或换 manifest"
                               % (entry, _rust_debug_list(supported)))

RECIPE_IDS = (
    "request-usage-anthropic-v1",
    "request-usage-openai-total-input-v1",
    "request-usage-four-bucket-v1",
)

RESERVED_SLUGS = (
    "claude-code", "codex", "dsh", "workbuddy", "openclaw", "hermes",
)

OVERRIDE_SLOTS = (
    "event_ts", "model_raw", "provider_raw",
    "uncached_input_tokens", "total_input_tokens",
    "cache_read_tokens", "cache_write_tokens",
    "output_tokens", "provider_request_id",
)

DEFAULT_MAX_ROWS_PER_FILE = 50_000
HARD_MAX_ROWS_PER_FILE = 500_000

_SLUG_RE = _re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_DOTTED_RE = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")


class ManifestError(Exception):
    def __init__(self, field, problem):
        super().__init__("%s: %s" % (field, problem))
        self.field = field
        self.problem = problem


class PluginManifest(object):
    """校验后的 manifest（与 Rust `PluginManifest` 同字段）。"""

    def __init__(self, slug, display_name, roots, include, session_pattern,
                 recipe, overrides, event_key_paths, max_rows_per_file,
                 billing_locked, compression="none"):
        self.slug = slug
        self.display_name = display_name
        self.roots = roots
        self.include = include
        self.session_pattern = session_pattern
        self.recipe = recipe
        self.overrides = overrides          # dict（插入序 = JSON 序）
        self.event_key_paths = event_key_paths
        self.max_rows_per_file = max_rows_per_file
        self.billing_locked = billing_locked
        self.compression = compression

    @property
    def facts_harness(self):
        return "harness:%s" % self.slug

    @property
    def facts_file_stem(self):
        return "harness-%s" % self.slug


def is_dotted_path(s):
    return bool(_DOTTED_RE.match(s))


def validate_session_pattern(pattern):
    field = "session.pattern"
    # 显式扫描（与 Rust 同一禁词表）：look-around、反向引用、Python 专属的
    # 命名反向引用 (?P= 与注释组 (?#、非 ?P 命名组。扫描先于编译——两语言
    # 必须拒绝同一批 manifest，不能依赖引擎失败模式的分歧。
    for banned in ("(?=", "(?!", "(?<=", "(?<!", "(?'", "(?P=", "(?#"):
        if banned in pattern:
            raise ManifestError(field, "受限正则子集不接受 %s…（look-around）" % banned)
    i = 0
    while i < len(pattern):
        if pattern[i] == "\\" and i + 1 < len(pattern) and pattern[i + 1].isdigit():
            raise ManifestError(field, "受限正则子集不接受反向引用（\\1…\\9）")
        i += 1
    rest = pattern
    while True:
        pos = rest.find("(?<")
        if pos < 0:
            break
        if rest[pos:].startswith("(?P<"):
            rest = rest[pos + 4:]
        else:
            raise ManifestError(field, "命名组只接受 Python 风格 (?P<id>...) 写法")
    try:
        compiled = _re.compile(pattern)
    except _re.error as e:
        raise ManifestError(field, "正则编译失败：%s" % e)
    names = [n for n in compiled.groupindex.keys()]
    if names != ["id"]:
        raise ManifestError(
            field, "必须恰好一个具名组 (?P<id>...)（实际：%d个）" % len(names))
    return compiled


def _err(field, problem):
    return ManifestError(field, problem)


def _rust_debug_list(items):
    """Rust `{:?}` 的切片 Debug 形状（`["a", "b"]`）——错误串逐字对齐用。"""
    return "[" + ", ".join('\"%s\"' % i for i in items) + "]"


def _string_array(value, field, min_len, max_len):
    if not isinstance(value, list):
        raise _err(field, "必须是字符串数组")
    if len(value) < min_len or len(value) > max_len:
        raise _err(field, "长度必须 %d..=%d" % (min_len, max_len))
    out = []
    for i, v in enumerate(value):
        if not isinstance(v, str):
            raise _err("%s[%d]" % (field, i), "必须是字符串")
        if v == "":
            raise _err("%s[%d]" % (field, i), "不能为空")
        out.append(v)
    return out


def _is_valid_glob(pattern):
    return (len(pattern) > 0
            and "[" not in pattern and "]" not in pattern
            and "{" not in pattern and "}" not in pattern
            and "\\" not in pattern)


def parse_manifest(value):
    """dict → PluginManifest（与 Rust `parse_manifest` 同一校验序列）。"""
    if not isinstance(value, dict):
        raise _err("(root)", "manifest 必须是 JSON object")

    # P0 capability 边界（附录 A 尾注）：显式拒绝，不是未知字段的泛化报错。
    if "records" in value:
        raise _err("records", "DSL records 是 P2 capability，当前运行时不支持"
                              "（manifest_version 1 P0）")
    if "adapter" in value:
        raise _err("adapter", "脚本 adapter 是 P1.5 capability，当前运行时不支持"
                              "（manifest_version 1 P0）")

    known = ("$schema", "manifest_version", "slug", "display", "discovery",
             "source", "session", "recipe", "overrides", "event_key",
             "limits", "billing", "requires", "min_app_version")
    for key in value.keys():
        if key not in known:
            raise _err(key, "未知字段（schema additionalProperties: false）")

    if "$schema" in value and not isinstance(value["$schema"], str):
        raise _err("$schema", "必须是字符串（schema URL）")

    version = value.get("manifest_version")
    # Rust `as_u64`：负数 / bool / >u64 的整数都走「必须是整数 1」分支
    # （serde_json 对越界整数解析为 f64，as_u64 为 None）——不是版本分支。
    if (not isinstance(version, int) or isinstance(version, bool)
            or version < 0 or version > 2 ** 64 - 1):
        raise _err("manifest_version", "必须是整数 1")
    if version != MANIFEST_VERSION:
        raise _err("manifest_version",
                   "不支持的版本 %d（本运行时支持 %d）——请升级 app 或换 manifest"
                   % (version, MANIFEST_VERSION))

    _negotiate_requirements(value, CapabilitySet())

    slug = value.get("slug")
    if not isinstance(slug, str):
        raise _err("slug", "必须是非空字符串")
    if not _SLUG_RE.match(slug):
        raise _err("slug", "必须匹配 ^[a-z][a-z0-9-]{0,31}$")
    if slug in RESERVED_SLUGS or slug.startswith("harness-") or slug.startswith("plugin-"):
        raise _err("slug", "`%s` 是保留字（官方执行环境名 / harness- 与 plugin- 前缀）" % slug)

    display = value.get("display")
    if not isinstance(display, dict):
        raise _err("display", "必须是 object")
    for key in display.keys():
        if key != "name":
            raise _err("display.%s" % key, "未知字段")
    display_name = display.get("name")
    if not isinstance(display_name, str):
        raise _err("display.name", "必须是非空字符串")
    if len(display_name) == 0 or len(display_name) > 24:
        raise _err("display.name", "长度必须 1..=24 字符")

    discovery = value.get("discovery")
    if not isinstance(discovery, dict):
        raise _err("discovery", "必须是 object")
    for key in discovery.keys():
        if key not in ("roots", "include"):
            raise _err("discovery.%s" % key, "未知字段")
    roots = _string_array(discovery.get("roots"), "discovery.roots", 1, 16)
    include = _string_array(discovery.get("include"), "discovery.include", 1, 16)
    for i, g in enumerate(include):
        if not _is_valid_glob(g):
            raise _err("discovery.include[%d]" % i,
                       "只支持 *、?、** 与字面量字符（不支持字符类/花括号）")

    source = value.get("source")
    if not isinstance(source, dict):
        raise _err("source", "必须是 object")
    for key in source.keys():
        if key not in ("format", "compression"):
            raise _err("source.%s" % key, "未知字段")
    fmt = source.get("format")
    if not isinstance(fmt, str):
        raise _err("source.format", "必须是字符串")
    if fmt != "jsonl":
        raise _err("source.format", "P0 仅支持 jsonl（得到 %s）" % fmt)
    compression = source.get("compression", "none")
    if not isinstance(compression, str):
        raise _err("source.compression", "必须是字符串")
    if compression not in ("none", "zstd"):
        raise _err("source.compression", "仅支持 none 或 zstd（得到 %s）" % compression)

    session = value.get("session")
    if not isinstance(session, dict):
        raise _err("session", "必须是 object")
    for key in session.keys():
        if key not in ("from", "pattern"):
            raise _err("session.%s" % key, "未知字段")
    from_kind = session.get("from")
    if not isinstance(from_kind, str):
        raise _err("session.from", "必须是字符串")
    if from_kind != "filename":
        raise _err("session.from", "P0 仅支持 filename（record 提取是 P2）")
    pattern = session.get("pattern")
    if not isinstance(pattern, str):
        raise _err("session.pattern", "必须是字符串")
    session_pattern = validate_session_pattern(pattern)

    recipe = value.get("recipe")
    if not isinstance(recipe, str):
        raise _err("recipe", "必须是字符串")
    if recipe not in RECIPE_IDS:
        raise _err("recipe", "未知 recipe `%s`（已知：%s）"
                   % (recipe, _rust_debug_list(RECIPE_IDS)))

    overrides = {}
    raw_overrides = value.get("overrides")
    if raw_overrides is not None:
        if not isinstance(raw_overrides, dict):
            raise _err("overrides", "必须是 object")
        for k, v in raw_overrides.items():
            if k not in OVERRIDE_SLOTS:
                raise _err("overrides.%s" % k,
                           "未知槽位（允许：%s）" % _rust_debug_list(OVERRIDE_SLOTS))
            if not isinstance(v, str):
                raise _err("overrides.%s" % k, "必须是点路径字符串")
            if not is_dotted_path(v):
                raise _err("overrides.%s" % k,
                           "必须是纯点路径 IDENT(.IDENT)*（无表达式/函数/下标）")
            overrides[k] = v

    event_key = value.get("event_key")
    if not isinstance(event_key, dict):
        raise _err("event_key", "必须是 object")
    for key in event_key.keys():
        if key != "paths":
            raise _err("event_key.%s" % key, "未知字段")
    event_key_paths = _string_array(event_key.get("paths"), "event_key.paths", 1, 8)
    for i, p in enumerate(event_key_paths):
        if not is_dotted_path(p):
            raise _err("event_key.paths[%d]" % i, "必须是纯点路径 IDENT(.IDENT)*")

    max_rows = DEFAULT_MAX_ROWS_PER_FILE
    limits = value.get("limits")
    if limits is not None:
        if not isinstance(limits, dict):
            raise _err("limits", "必须是 object")
        for key in limits.keys():
            if key != "max_rows_per_file":
                raise _err("limits.%s" % key, "未知字段")
        n = limits.get("max_rows_per_file")
        if n is not None:
            if not isinstance(n, int) or isinstance(n, bool):
                raise _err("limits.max_rows_per_file", "必须是正整数")
            if n <= 0 or n > HARD_MAX_ROWS_PER_FILE:
                raise _err("limits.max_rows_per_file",
                           "必须 1..=%d" % HARD_MAX_ROWS_PER_FILE)
            max_rows = n

    billing_locked = False
    billing = value.get("billing")
    if billing is not None:
        if not isinstance(billing, dict):
            raise _err("billing", "必须是 object")
        for key in billing.keys():
            if key != "policy":
                raise _err("billing.%s" % key, "未知字段")
        policy = billing.get("policy")
        if not isinstance(policy, str):
            raise _err("billing.policy", "必须是字符串")
        if policy != "lock:metered_estimate":
            raise _err("billing.policy",
                       "插件执行环境仅接受 `lock:metered_estimate`（得到 `%s`）——官方订阅档须官方适配器"
                       % policy)
        billing_locked = True

    return PluginManifest(slug, display_name, roots, include, session_pattern,
                          recipe, overrides, event_key_paths, max_rows,
                          billing_locked, compression)


def load_manifest(path):
    """读文件 + 校验 + slug == 目录名（与 Rust `load_manifest` 同语义）。

    错误串与 Rust 逐字对齐（handler 原样透出给 payload）。io 错误的 OS 文案
    两语言天然不同——golden fixtures 不覆盖该分支（有效 manifest），此处的
    对齐目标是校验类错误。
    """
    import json
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as e:
        raise Exception("manifest `%s` 不可读：%s" % (path, e))
    try:
        value = json.loads(raw.decode("utf-8"))
    except ValueError as e:
        raise Exception("manifest `%s` 不是合法 JSON：%s" % (path, e))
    try:
        manifest = parse_manifest(value)
    except ManifestError as e:
        raise Exception("manifest 校验失败：%s: %s" % (e.field, e.problem))
    import os
    dir_name = os.path.basename(os.path.dirname(os.path.abspath(str(path))))
    if dir_name != manifest.slug:
        raise Exception("slug `%s` 与 manifest 所在目录名 `%s` 不一致（§3.1）"
                        % (manifest.slug, dir_name))
    revision = hashlib.sha256(raw).hexdigest()[:16]
    return manifest, revision
