# jieba 分词 vs 字符 bigram：overlap 的取舍实验

复现 `docs/ENGINEERING.md` ADR-002 里那三张表。

```bash
# 1. 先产出一份扫描快照当语料（用你自己的机器，或任何 --path 指向的语料）
cd ../..
cargo run --release -- --harness all --json /tmp/ov.json

# 2. 跑实验
cd experiments/jieba-overlap
cargo run --release -- /tmp/ov.json
```

> **基线是近似复刻，不是生产实现。**主 crate 的分词函数未导出，这里为了同条件
> 对比重写了一份；同一语料上 ≥0.25 的对数是 13 vs 生产的 11。权威数字请跑
> `agent-vitals overlap --json`，这个实验回答的是「换个分词器会怎样」。

输出五段：

1. **词性标注实况** —— 证明 jieba 把每个英文词标成 `eng`
2. **三种配方的对比** —— 提案原版（只留 v/n）、加回 eng、当前实现
3. **中文子集单独比** —— jieba 的收益全在这里
4. **重叠系数 vs Jaccard** —— 为什么它是误报发生器
5. **成本** —— 词典加载耗时

## 为什么这个实验值得留在仓库里

ADR-002 的结论是「**先不加 jieba**」，而拒绝一个提案最容易变成「凭感觉说不」。
留下可复现的实验，是为了让下一个人（或换了语料的你）能**用一条命令推翻它** ——
如果你的语料里中文占比更高、或者常驻进程摊薄了词典加载成本，结论就该翻过来。

判据写在 ADR-002 §9.4。
