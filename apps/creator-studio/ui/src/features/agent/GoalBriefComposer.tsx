import { useState } from "react";
import { creationGoalBrief } from "../home/workbenchModel";

export function GoalBriefComposer(props: Readonly<{ goal: string; onGoalChange: (goal: string) => void; scope?: string }>) {
  const { goal, onGoalChange, scope } = props;
  const [copying, setCopying] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const base = creationGoalBrief(goal);
  const brief = base && scope ? `${base}\n\n当前范围：${scope}` : base;
  const copyGoal = async () => {
    if (!brief || copying) return;
    if (!navigator.clipboard?.writeText) {
      setCopyStatus("当前环境无法访问剪贴板；未复制，也未创建或执行 Agent Task。");
      return;
    }
    setCopying(true); setCopyStatus("");
    try {
      await navigator.clipboard.writeText(brief);
      setCopyStatus("任务说明已复制；未创建或执行 Agent Task。");
    } catch {
      setCopyStatus("复制失败；未创建或执行 Agent Task。请检查剪贴板权限后重试。");
    } finally { setCopying(false); }
  };
  return <div className="goal-composer">
    <textarea aria-label="创作目标" value={goal} onChange={event => { onGoalChange(event.target.value); setCopyStatus(""); }} placeholder="描述希望 Agent 协助的创作目标；当前仅复制，不会执行" />
    <div className="actions"><button disabled={!brief || copying} onClick={() => void copyGoal()}>{copying ? "正在复制…" : "复制任务说明"}</button></div>
    {copyStatus && <p className="status" role="status">{copyStatus}</p>}
  </div>;
}
