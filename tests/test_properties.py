#!/usr/bin/env python3
"""属性测试（ENGINEERING.md §4.4 第 3 层）。

§4.4 明确限定**只做两件事**，因为属性测试的价值集中在一处：

    用例只能测你想到的字段。

脱敏已经漏过三次，三次都是「没想到还有这个字段」：名字残留在 `path`、
`description` 自由文本清不干净、`removed_skills` 与 `namespace` 从来不在
收集白名单里。用例测不出这个模式——写用例的人如果想得到那个字段，一开始
就不会漏。属性测试专门覆盖这类失效。

**hypothesis 是可选依赖。**装了就跑，没装就跳过，仓库的「零依赖」性质不变
（那条约束针对的是被分发的扫描器，不是开发期工具）。

    python3 -m venv .venv && .venv/bin/python -m pip install hypothesis
    .venv/bin/python -m unittest tests.test_properties -v
"""

import importlib.util
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("scan", ROOT / "scripts" / "scan.py")
scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan)

try:
    from hypothesis import HealthCheck, assume, given, settings
    from hypothesis import strategies as st
except ImportError:  # pragma: no cover
    raise unittest.SkipTest(
        "未安装 hypothesis，跳过属性测试。"
        "装法：python3 -m venv .venv && .venv/bin/python -m pip install hypothesis")


# `redact()` 自己产出的人工串：别名、description 哨兵、用户名占位。
# 断言「真名没残留」之前必须先把它们抹掉 —— 一个叫 "kill" 的 skill 会因为
# 输出里有 "skill-001" 被误判，一个叫 "r" 的会被 "<redacted: 28 chars>" 误判，
# 一个叫 "user" 的会被 "<user>" 误判。这些子串来自脱敏器的模板，不携带任何
# 原始信息。抹掉之后属性才精确，也不必对生成的名字设字母表限制。
ALIAS_RE = re.compile(r"(?:skill|plugin|market)-\d{3,}"
                      r"|<redacted: \d+ chars>"
                      r"|<user>")

# 名字的字母表：真实 skill 名的形状（kebab-case 字母数字）。
# 不放开到任意 Unicode 是有意的 —— 属性测试要覆盖的是**结构**维度
# （名字可能出现在哪些字段、哪些嵌套层级），不是字符集维度。
NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
# 统一带 zz 前缀。**不是洁癖，是为了让断言有意义**：语料里的结构字面量
# （config.json、.openclaw、/home/u/...）本身含字母，一个生成成 "c" 的名字
# 会在 config.json 里被「找到」，报出并不存在的泄露。前缀取任何结构字面量
# 里都没有的 zz。这不削弱性质 —— 属性测试覆盖的是**结构**维度（名字可能
# 出现在哪些字段、哪些层级），不是字符集维度。
# Rust 侧 src/redact.rs 的 names() 用同一约定。
names = st.text(alphabet=NAME_ALPHABET, min_size=1, max_size=14).map(lambda s: "zz" + s)
name_sets = st.lists(names, min_size=1, max_size=6, unique=True)

SLOW = settings(max_examples=200, deadline=None,
                suppress_health_check=[HealthCheck.too_slow])


def string_values(o):
    """产出文档里所有**字符串值**。

    不能拿 json.dumps 之后的整篇文本做子串搜索：一个生成成 "1" 的名字会命中
    `"line": 1` 这类**整数**字面量，报出并不存在的泄露。键名同理 —— 键是结构
    的一部分，不经过脱敏，也不该参与断言。只看字符串叶子，断言才精确。
    """
    if isinstance(o, dict):
        for v in o.values():
            yield from string_values(v)
    elif isinstance(o, list):
        for v in o:
            yield from string_values(v)
    elif isinstance(o, str):
        yield o


def build_output(skill_names, plugin_names, market_names, removed_names,
                 instance_names=("zzinst",)):
    """拼一份形状与真实扫描输出一致的文档，把名字种进每一个已知承载位置。

    刻意包含三种真实存在、但容易被漏掉的位置：

      - `path` 里的名字（第一次泄露）
      - `removed_skills` —— 名字**只**存在于基线，当前 skills[] 里根本没有
        （第三次泄露的一半）
      - `plugin_key` / `enabled_plugins` 的 `<plugin>@<market>` 复合形态
        （第三次泄露的另一半）
    """
    skills = []
    for i, n in enumerate(skill_names):
        plug = plugin_names[i % len(plugin_names)]
        mkt = market_names[i % len(market_names)]
        inst = instance_names[i % len(instance_names)]
        skills.append({
            "name": n,
            "dir_name": n,
            "namespace": plug,
            "plugin_key": "%s@%s" % (plug, mkt),
            "usage_key_matched": "%s:%s" % (plug, n),
            # 多执行环境字段：instance_id 是用户机器上的目录名，同样要脱敏；
            # instance_root / config_path / conflict_domain 里嵌着同一串。
            #
            # **必须用独立于 markets 的一组名字。**曾经这里复用 mkt，于是
            # instance_id 即便不在收集白名单里，也会被 plugin_key 那条顺带
            # 清掉 —— 变异测试（把 INSTANCE_NAME_KEYS 关掉）照样全绿，
            # 测试看起来在测它，其实没有。
            "instance_id": inst,
            "instance_root": "/home/u/.openclaw/%s" % inst,
            "config_path": "/home/u/.openclaw/%s/config.json" % inst,
            "conflict_domain": "openclaw:%s" % inst,
            "path": "/home/u/.claude/plugins/cache/%s/%s/unknown/skills/%s"
                    % (mkt, plug, n),
            "description": "free text mentioning %s and %s" % (n, plug),
            "security": {"findings": [
                {"rule": "r", "where": "%s/run.sh" % n, "line": 1,
                 "match": "see %s" % n}]},
        })
    return {
        "skills": skills,
        "plugin_state": {
            # 全组合，保证**每一个**插件名与 marketplace 名都真的出现在文档里。
            # 按下标取会让多出来的名字一个都没被种进去，断言却仍在找它们，
            # 于是命中 ".claude" 之类的结构常量，报出假泄露。
            "enabled_plugins": ["%s@%s" % (p, m)
                                for p in plugin_names for m in market_names],
        },
        "conflicts": [{"name": n, "effective": {"path": "/home/u/x/%s" % n},
                       "shadowed": [{"path": "/home/u/y/%s" % n}]}
                      for n in skill_names],
        "trigger_data": {
            "zombie_candidates": [{"name": n, "path": "/h/%s" % n}
                                  for n in skill_names],
            "too_new_to_judge": [{"name": n} for n in skill_names],
        },
        "structure": {
            "oversized": [{"name": n, "path": "/h/%s" % n} for n in skill_names],
            "large_data_corpus": [{"name": n} for n in skill_names],
        },
        "security": {"flagged": [{"name": n, "path": "/h/%s" % n,
                                  "findings": [{"match": n}]}
                                 for n in skill_names]},
        "diff_vs_baseline": {
            # 这批名字**只**出现在这里。当前扫描的 skills[] 里没有它们，
            # 所以只从 skills[].name 收集的实现必然漏掉。
            # 形状必须跟真实输出一致：dict 而不是裸名列表。喂裸名的话，
            # 这条属性测的就是一个 scan.py 不再产出的形状。
            "removed_skills": [{"harness": "claude-code", "instance_id": None,
                                "namespace": "", "name": n} for n in removed_names],
            "added_skills": [{"harness": "claude-code", "instance_id": None,
                              "namespace": "", "name": n} for n in skill_names],
            "usage_delta": [{"name": n, "delta": 1} for n in skill_names],
            "new_security_findings": [{"skill": n, "rule": "r"} for n in skill_names],
        },
    }


class TestRedactionLeavesNoRealName(unittest.TestCase):
    """属性 1：任意名字集合下，输出里不得出现任何真名 —— 任何字段、任何层级。

    §4.4 单列这条的理由：两次真实泄露都是「没想到还有这个字段」。
    """

    @given(name_sets, name_sets, name_sets, name_sets, name_sets)
    @SLOW
    def test_no_real_name_survives_anywhere(self, sk, pl, mk, rm, inst):
        # 名字集合之间不得交叉，否则「谁该映射成什么」本身是歧义的
        pools = [set(sk), set(pl), set(mk), set(rm), set(inst)]
        for i in range(len(pools)):
            for j in range(i + 1, len(pools)):
                assume(not pools[i] & pools[j])

        out = scan.redact(build_output(sk, pl, mk, rm, inst), names=True, name_map={})
        for value in string_values(out):
            # 占位符必须落在 NAME_ALPHABET 之外，否则它自己会被当成真名命中
            scrubbed = ALIAS_RE.sub("\x00", value)
            for n in sk + pl + mk + rm + inst:
                self.assertNotIn(n, scrubbed,
                                 "真名 %r 残留在脱敏输出的字符串值 %r 里" % (n, value))

    @given(name_sets)
    @SLOW
    def test_distinct_names_get_distinct_aliases(self, sk):
        """不同的名字不得映射到同一个别名，否则报告的结构关系被破坏。"""
        nm = {}
        scan.redact(build_output(sk, ["p"], ["m"], []), names=True, name_map=nm)
        assume(len(set(nm)) == len(nm))
        self.assertEqual(len(set(nm.values())), len(nm.values()),
                         "别名发生碰撞：%r" % nm)

    @given(name_sets, name_sets)
    @SLOW
    def test_same_name_maps_consistently_within_one_document(self, sk, pl):
        """同一个名字在所有字段里必须换成同一个别名，否则读者无法把行对上。"""
        assume(not set(sk) & set(pl))
        out = scan.redact(build_output(sk, pl, ["m"], []), names=True, name_map={})
        for s in out["skills"]:
            self.assertEqual(s["name"], s["dir_name"])
            self.assertTrue(s["path"].endswith("/" + s["name"]),
                            "path 末段与 name 必须换成同一个别名")
            self.assertEqual(s["usage_key_matched"],
                             "%s:%s" % (s["namespace"], s["name"]))

    @given(name_sets)
    @SLOW
    def test_descriptions_always_dropped_never_pattern_cleaned(self, sk):
        out = scan.redact(build_output(sk, ["p"], ["m"], []), names=True, name_map={})
        for s in out["skills"]:
            self.assertRegex(s["description"], r"^<redacted: \d+ chars>$")

    @given(name_sets, name_sets)
    @SLOW
    def test_structure_is_preserved(self, sk, rm):
        """脱敏不得改变文档结构 —— 计数、键集合、嵌套层级全部不变。"""
        assume(not set(sk) & set(rm))
        src = build_output(sk, ["p"], ["m"], rm)
        out = scan.redact(src, names=True, name_map={})

        def shape(o):
            if isinstance(o, dict):
                return {k: shape(v) for k, v in o.items()}
            if isinstance(o, list):
                return [shape(v) for v in o]
            return type(o).__name__

        self.assertEqual(shape(src), shape(out))


class TestEstTokensTotality(unittest.TestCase):
    """属性 2：`est_tokens` 对任意 Unicode 输入不抛异常且非负。"""

    @given(st.text())
    @SLOW
    def test_never_raises_and_never_negative(self, s):
        self.assertGreaterEqual(scan.est_tokens(s), 0)

    @given(st.text(alphabet=st.characters(min_codepoint=0, max_codepoint=0x10FFFF)))
    @SLOW
    def test_full_unicode_range(self, s):
        """含代理区、私用区、未分配码位。CJK 判据写成字节比较会在这里炸。"""
        self.assertGreaterEqual(scan.est_tokens(s), 0)

    @given(st.text(min_size=1))
    @SLOW
    def test_monotonic_under_concatenation(self, s):
        """拼接不得让估算变小。int() 截断使它不严格可加，但必须单调不减。"""
        self.assertGreaterEqual(scan.est_tokens(s + s), scan.est_tokens(s))

    @given(st.text(alphabet=st.characters(min_codepoint=0x4E00, max_codepoint=0x9FFF),
                   min_size=3, max_size=60))
    @SLOW
    def test_cjk_is_denser_than_ascii_of_equal_length(self, s):
        """同样字符数，CJK 的 token 估算必须更高（1.5 vs 4 字符每 token）。"""
        self.assertGreater(scan.est_tokens(s), scan.est_tokens("a" * len(s)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
