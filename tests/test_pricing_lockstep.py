# 价格表单源锁步测试：CLI 用 `assets/pricing.json`（单一真相源；v0.8 Phase E5
# 从 Python 包内搬到仓库根——三方共读，不是 Python 包私有数据）。
#
# **2026-09-22：`dsh-client` 已拆成独立仓库（`dsh-agent-vitals-audit`），不再
# 是本仓库的一部分。** 这份测试原本守两份派生副本（`src/client/styles/
# index.ts` 的展示用 PRICING 内嵌、`integrations/dsh-client/pricing.json` 的
# 运行时复制），两份现在都活在那个独立仓库里，本仓库的测试进程摸不到它们
# ——不是「文件缺失是 bug」，是「这条守卫的另一半已经不在同一个仓库」。
# 拆分本身的取舍与手动同步纪律见 `dsh-agent-vitals-audit` 仓库 README 顶部
# 「来源与同步义务」一节：`pricing.json` 变了要手动 `cp` 过去，不再有测试
# 兜底忘记这一步——这是拆分的真实代价，写在这里不是为了假装它不存在。
#
# 两个测试类原样保留（skip 而不是删除）：万一哪天又把 dsh-client 的某个
# fork/副本放回本仓库同一个相对路径下，这条锁步测试立刻原样生效，不用
# 重新写。

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PRICING_JSON = REPO / "assets" / "pricing.json"
CLIENT_JS = REPO / "integrations" / "dsh-client" / "src" / "client" / "styles" / "index.ts"
HARNESS_PRICING_JSON = REPO / "integrations" / "dsh-client" / "pricing.json"

_has_node = shutil.which("node") is not None
# `.is_dir()` alone 靠不住——拆分当天就抓到过一次：`git rm` 只删跟踪文件，
# 一个跑过 `npm install`/`npm run build` 的旧 checkout 会在这个目录下留一堆
# gitignored 的 node_modules/lib/.DS_Store，目录本身还在，这个判定就会误报
# 「存在」，让下面两条测试从「优雅跳过」变回读不到文件的真失败。用签入过的
# package.json 是否存在来判定，比目录存在与否更接近「这个包还在不在」。
_dsh_client_present = (REPO / "integrations" / "dsh-client" / "package.json").is_file()


def _client_pricing():
    """用 node 求值 styles/index.ts 里的 `export const PRICING… = {…}` 字面量。

    路径必须用 `json.dumps` 转成合法 JS 字符串字面量，不能裸拼进单引号——
    Windows 的 `str(Path)` 是反斜杠分隔（`D:\\a\\agent-vitals\\...`），裸拼
    进 `'...'` 会被 JS 当成转义序列吃掉（`\\a`→`a`、`\\s`→`s`），把路径拼成
    读不到文件的乱码，`fs.readFileSync` 抛出未捕获异常、node 非零退出——
    这条测试在 Windows CI 上一直是这样挂的。`json.dumps` 输出的双反斜杠
    JS/JSON 都认，跨平台都对。
    """
    script = (
        "const fs=require('fs');"
        f"const src=fs.readFileSync({json.dumps(str(CLIENT_JS))},'utf8');"
        # TS 声明带类型注解（`export const PRICING: Record<…> = {`），所以从
        # `=` 之后抓字面量；结束锚点是行首的 `}`（该常量的字面量不缩进收尾）。
        "const m=src.match(/export const PRICING[^=]*=\\s*(\\{[\\s\\S]*?\\n\\})\\n/);"
        "if(!m){console.error('PRICING literal not found');process.exit(1)}"
        "const PRICING=eval('('+m[1]+')');"
        "console.log(JSON.stringify(PRICING));"
    )
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@unittest.skipUnless(_has_node, "node not available — cannot evaluate client.js PRICING")
@unittest.skipUnless(
    _dsh_client_present,
    "integrations/dsh-client/ 已拆成独立仓库 dsh-agent-vitals-audit——这条锁步"
    "测试的另一半（styles/index.ts 的 PRICING）不在本仓库了，手动同步纪律见"
    "那个仓库的 README",
)
class PricingLockstepTests(unittest.TestCase):
    def test_client_pricing_matches_pricing_json(self):
        pricing = json.loads(PRICING_JSON.read_text(encoding="utf-8"))
        client = _client_pricing()
        # 价目表改成按供应商分层后，styles/index.ts 那份**展示用**副本对应的是
        # 回落供应商（原厂）的模型集合——它只用来查模型短名，不参与算钱，所以
        # 不需要镜像每一家供应商的表。
        fb = pricing["fallback_provider"]
        cards = pricing["providers"][fb]["models"]

        # client.js PRICING 的形状：{model: {inputUncached, inputCached, output}, ...}
        self.assertEqual(set(client.keys()), set(cards.keys()),
                         "client.js 与 pricing.json 的模型卡集合不一致")
        for model in cards:
            # (pricing.json 键, client.js 键) —— 键名不同，值必须一致
            for src_key, dst_key in (
                ("input_uncached", "inputUncached"),
                ("input_cached", "inputCached"),
                ("output", "output"),
            ):
                # pricing.json 用 off_peak/peak，client.js 用 off/peak（同名不同前缀）
                for json_tariff, client_tariff in (("off_peak", "off"), ("peak", "peak")):
                    self.assertEqual(
                        client[model][dst_key][client_tariff],
                        cards[model][src_key][json_tariff],
                        f"{model}.{dst_key}.{json_tariff} 不一致：pricing.json="
                        f"{cards[model][src_key][json_tariff]} client.js={client[model][dst_key][client_tariff]}",
                    )

    def test_cache_write_is_zero(self):
        # 报价表没有缓存写入行 → 两处都按 0 计（注释标注假设）
        pricing = json.loads(PRICING_JSON.read_text(encoding="utf-8"))
        self.assertEqual(pricing["cache_write_per_million"], 0)


@unittest.skipUnless(
    _dsh_client_present,
    "integrations/dsh-client/ 已拆成独立仓库 dsh-agent-vitals-audit——运行时"
    "副本 pricing.json 不在本仓库了，手动同步纪律见那个仓库的 README",
)
class HarnessPricingCopyLockstepTests(unittest.TestCase):
    """integrations/dsh-client/pricing.json 是 pricing.json 的运行时副本（执行环境 costReport
    投影读它算钱），应该逐字节相同——不需要 node，任何环境都跑。"""

    def test_harness_copy_matches_source_byte_for_byte(self):
        if not HARNESS_PRICING_JSON.exists():
            self.fail("integrations/dsh-client/pricing.json 缺失——运行时副本没有从 "
                      "assets/pricing.json 复制过去，harness/index.ts "
                      "的 costReport 投影会在 readFileSync 处直接崩")
        self.assertEqual(
            HARNESS_PRICING_JSON.read_bytes(), PRICING_JSON.read_bytes(),
            "integrations/dsh-client/pricing.json 与 assets/pricing.json 内容不同——"
            "改了价目表后忘了重新复制到 dsh-client/，执行环境的 costReport 会算出旧价钱")


if __name__ == "__main__":
    unittest.main()
