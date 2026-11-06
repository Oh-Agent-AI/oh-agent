#!/usr/bin/env python3
"""删除已完全并入 main 的 worktree（在主仓库根目录运行）。

只删满足全部条件的：HEAD 是 main 的祖先、工作区没有未提交改动（忽略指向主仓库
node_modules 的软链接）。分支保留——删分支另行决定。默认只打印计划，加 --apply 才执行。
"""
import os, subprocess, sys

KEEP = {"city-plan-repair", "city-plan-manual-repair-spec-dff6ae"}  # 当前会话正在用
apply = "--apply" in sys.argv

def git(*a, cwd=None):
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True)

wts, cur = [], None
for line in git("worktree", "list", "--porcelain").stdout.splitlines():
    if line.startswith("worktree "):
        cur = {"path": line[9:]}; wts.append(cur)
    elif line.startswith("HEAD "): cur["head"] = line[5:]
    elif line.startswith("locked"): cur["locked"] = True

for w in wts[1:]:
    name = os.path.basename(w["path"])
    if name in KEEP:
        print(f"keep   {name}（当前会话）"); continue
    if git("merge-base", "--is-ancestor", w["head"], "main").returncode != 0:
        print(f"keep   {name}（有未并入 main 的提交）"); continue
    dirty = [l for l in git("status", "--porcelain", "--untracked-files=all", cwd=w["path"]).stdout.splitlines()
             if not (l.startswith("?? ") and os.path.islink(os.path.join(w["path"], l[3:].rstrip("/"))))]
    if dirty:
        print(f"keep   {name}（{len(dirty)} 个未提交改动）"); continue
    print(f"remove {name}{'（locked）' if w.get('locked') else ''}")
    if apply:
        r = git("worktree", "remove", "--force", "--force", w["path"])
        if r.returncode: print("   失败:", r.stderr.strip())
if apply: git("worktree", "prune")
else: print("\n只是预览。确认后加 --apply 执行。")
