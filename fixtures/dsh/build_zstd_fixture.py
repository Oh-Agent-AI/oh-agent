#!/usr/bin/env python3
"""生成 R2a DSH 的**多帧 zstd** 会话夹具 + workspace.json。

背景（docs/R2A_CONTRACT_DESIGN.md §4.3 / §5.2）：DSH 默认持久化后端
`@deepseek-ai/dsh-session-persistence-jsonl` 在**每次 flush 追加一个新的 zstd 帧**
——一个会话的 `.zstd` 文件是多个帧的拼接，不是单帧。`src/dsh.rs` 的
`decode_zstd_multi_frame`（Rust 侧 ruzstd StreamingDecoder 逐帧读）与
`adapters/dsh.py` 的同名镜像（Python 侧 zstandard `decompressobj` 逐帧循环）都
为这个形状而生。本脚本把 `behavior.jsonl`（裸 JSONL，等价 compression:'none'）按
行切成 3 段，每段独立压缩成自己的 zstd 帧，拼接成 `session.jsonl.zstd`——
正好模拟「flush 了 3 次」的落盘形态。

依赖：`zstandard`（**可选**，与 repo 其余 fixture 生成器不同，本脚本需要它出帧；
CI 不依赖它——产物 `session.jsonl.zstd` 已提交，解码走 Rust ruzstd / Python
zstandard，两侧都只在测试运行时才需要）。没装 zstandard 时本脚本直接报错退出，
已提交的产物不受影响。

用法（在 repo 根跑，保持行为确定性）：
    python3 fixtures/dsh/build_zstd_fixture.py

自校验：解码产物必须逐字节还原 `behavior.jsonl`；帧数必须 ≥2（否则就不是
「多帧」夹具，本脚本立即失败）。产物确定性：同一输入 + 同一 zstandard 版本 →
同一字节（zstd 默认 level=3，无 content-size 窗口内确定）。
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# 分帧切点（行号，1-based，闭区间）——3 段 = 3 个 flush。对齐「每次 flush 追加
# 一批连续事件」的真实语义；只在**行间**切，绝不拦腰斩断一条 JSON（JSONL 记录
# 边界只能是换行，见 adapters/dsh.py::parse_session_log 的注释）。
CHUNK_SPANS = [(1, 50), (51, 100), (101, None)]


def main() -> int:
    try:
        import zstandard as zstd
    except ImportError:
        print("error: 需要 zstandard（pip install zstandard）才能生成多帧夹具",
              file=sys.stderr)
        return 2

    src = HERE / "behavior.jsonl"
    text = src.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)

    frames = []
    for start, end in CHUNK_SPANS:
        chunk = "".join(lines[start - 1:end])
        if not chunk.strip():
            print("error: 分帧切点 %r 落在空区（源已变更？）" % (start, end),
                  file=sys.stderr)
            return 2
        frames.append(zstd.ZstdCompressor().compress(chunk.encode("utf-8")))

    blob = b"".join(frames)

    # ── 自校验 1：多帧（≥2）不是单帧 ──────────────────────────────
    if len(frames) < 2:
        print("error: 只产出了 %d 帧，不是多帧夹具" % len(frames),
              file=sys.stderr)
        return 2

    # ── 自校验 2：解码逐字节还原源文件 ─────────────────────────────
    # 用 zstandard 的逐帧解压循环（与 adapters/dsh.py::decode_zstd_multi_frame
    # 同一逻辑：每次新帧新建 decompressobj，consumed = len(输入) - len(unused_data)）
    # 还原，必须与 behavior.jsonl 完全一致。这里的 consumed 是「本帧消费的字节数」，
    # 不是整个 blob 长度——用 n - len(unused_data) 会在后续帧上过冲、跳读字节。
    dctx = zstd.ZstdDecompressor()
    out = bytearray()
    pos = 0
    n = len(blob)
    while pos < n:
        dobj = dctx.decompressobj()
        chunk = blob[pos:]
        out += dobj.decompress(chunk)
        if not dobj.eof:
            print("error: 第若干帧未闭合（截断？），多帧解压失败", file=sys.stderr)
            return 2
        consumed = len(chunk) - len(dobj.unused_data)
        if consumed <= 0:
            print("error: 帧无进展（帧头合法但解不出字节）", file=sys.stderr)
            return 2
        pos += consumed
    if bytes(out) != text.encode("utf-8"):
        print("error: 解码产物与源不一致（长度 %d vs %d）"
              % (len(out), len(text)), file=sys.stderr)
        return 2

    (HERE / "session.jsonl.zstd").write_bytes(blob)

    # workspace.json：sess-behavior-0001 → (path, title)。与 Rust
    # r2a_store.rs::fake_dsh_under 内联的那份同构，落成文件供 Python 侧测试引用。
    ws = {
        "global": {"archivedSessionIds": []},
        "tables": {"workspaces": {
            "w1": {
                "path": "/Users/alice/projects/demo",
                "title": "demo project",
                "sessionIds": ["sess-behavior-0001"],
            },
        }},
    }
    (HERE / "workspace.json").write_text(
        json.dumps(ws, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    print("✓ session.jsonl.zstd：%d 帧，%d 字节（源 %d 字节）"
          % (len(frames), len(blob), len(text)))
    print("✓ workspace.json：sess-behavior-0001 → demo project")
    return 0


if __name__ == "__main__":
    sys.exit(main())
