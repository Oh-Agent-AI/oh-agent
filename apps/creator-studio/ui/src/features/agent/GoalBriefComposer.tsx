import { useState } from "react";
import { creationGoalBrief } from "../home/workbenchModel";
import { copyTextWithTimeout } from "./clipboardCopy";

export function GoalBriefComposer(props: Readonly<{ goal: string; onGoalChange: (goal: string) => void; scope?: string; context?: string; agentName?: string }>) {
  const { goal, onGoalChange, scope } = props;
  const [copying, setCopying] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [showManualCopy, setShowManualCopy] = useState(false);
  const base = creationGoalBrief(goal);
  const brief = base && [base, props.agentName && `目标 Agent：${props.agentName}`, scope && `当前范围：${scope}`, props.context && `关联对象：${props.context}`].filter(Boolean).join("\n\n");
  const copyGoal = async () => {
    if (!brief || copying) return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setShowManualCopy(true);
      setCopyStatus("当前环境无法访问剪贴板；未复制，也未创建或执行 Agent Task。");
      return;
    }
    setCopying(true); setCopyStatus(""); setShowManualCopy(false);
    try {
      await copyTextWithTimeout(() => clipboard.writeText(brief));
      setCopyStatus("任务说明已复制；未创建或执行 Agent Task。");
    } catch (cause) {
      setShowManualCopy(true);
      setCopyStatus(cause instanceof Error && cause.message === "clipboard_copy_timeout"
        ? "复制等待超时，未确认复制成功；请检查剪贴板权限后重试，或手动复制目标文本。未创建或执行 Agent Task。"
        : "复制失败；未创建或执行 Agent Task。请检查剪贴板权限后重试。");
    } finally { setCopying(false); }
  };
  return <div className="goal-composer">
    <textarea aria-label="创作目标" value={goal} onChange={event => { onGoalChange(event.target.value); setCopyStatus(""); setShowManualCopy(false); }} placeholder="描述希望 Agent 协助的创作目标；当前仅复制，不会执行" />
    <div className="actions"><button disabled={!brief || copying} onClick={() => void copyGoal()}>{copying ? "正在复制…" : "复制任务说明"}</button></div>
    {copyStatus && <p className="status" role="status">{copyStatus}</p>}
    {showManualCopy && <label>手动复制（点击文本后按 Ctrl/⌘C）<textarea className="goal-copy-fallback" readOnly value={brief ?? ""} onFocus={event => event.currentTarget.select()} /></label>}
  </div>;
}
