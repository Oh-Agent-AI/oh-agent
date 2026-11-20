import { useState } from "react";
import type { Project, ProjectRow } from "../../contracts/creatorStudio";
import { ProjectList } from "../project/ProjectList";
import { creationGoalBrief, recentCreatorProjects } from "./workbenchModel";

export function WorkbenchHome(props: Readonly<{
  projects: readonly ProjectRow[];
  projectsLoading: boolean;
  projectsError: string;
  project: Project | null;
  publishedReleaseId: string | null;
  hasPendingApproval: boolean;
  busy: boolean;
  onOpenProject: (projectId: string) => void;
  onOpenTemplates: (kind: "city" | "game") => void;
  onOpenAgent: () => void;
  onRefreshProjects: () => void;
}>) {
  const {
    projects, projectsLoading, projectsError, project, publishedReleaseId, hasPendingApproval, busy,
    onOpenProject, onOpenTemplates, onOpenAgent, onRefreshProjects,
  } = props;
  const [goal, setGoal] = useState("");
  const [copying, setCopying] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const brief = creationGoalBrief(goal);
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
  return <div className="workbench-home">
    <section className="home-hero" aria-labelledby="home-goal-title">
      <span className="welcome-kicker">START CREATING</span><h2 id="home-goal-title">从一个创作目标开始</h2>
      <p>描述想制作的 City 或 Game。当前仅复制任务说明，不会自动受理或运行 Agent。</p>
      <textarea aria-label="创作目标" value={goal} onChange={event => { setGoal(event.target.value); setCopyStatus(""); }} placeholder="例如：在海湾 City 中制作一个收集灯塔检查点的竞速游戏" />
      <div className="actions"><button disabled={!brief || copying} onClick={() => void copyGoal()}>{copying ? "正在复制…" : "复制任务说明"}</button></div>
      {copyStatus && <p className="status" role="status">{copyStatus}</p>}
    </section>

    <section className="home-template-grid" aria-label="创作模板入口">
      <button className="home-template-card" onClick={() => onOpenTemplates("city")}><span className="resource-kind">CITY</span><strong>创建或打开 City 世界</strong><span>使用真实 City 布局、世界包和独立实例。</span></button>
      <button className="home-template-card" onClick={() => onOpenTemplates("game")}><span className="resource-kind">GAME</span><strong>从模板 Game 开始</strong><span>选择真实玩法模板和 City 布局，建立可编辑 Creator Project。</span></button>
      <button className="home-template-card" disabled title="Story Project Registry 未接入"><span className="resource-kind">STORY</span><strong>Story（待接入）</strong><span>Story Project Registry 未接入，不从 Build 或运行状态推导 Story。</span></button>
    </section>

    <div className="home-columns">
      <section className="home-recent" aria-labelledby="recent-projects-title">
        <div className="home-section-heading"><div><span className="section-title" id="recent-projects-title">最近项目</span><p className="muted">仅显示 Host 返回的真实可编辑 Creator Project。</p></div><button className="secondary" disabled={projectsLoading} onClick={onRefreshProjects}>刷新</button></div>
        <ProjectList projects={recentCreatorProjects(projects)} loading={projectsLoading} error={projectsError} busy={busy} emptyMessage="还没有 Creator Project。可从上方模板入口开始。" onOpenProject={onOpenProject} onRefresh={onRefreshProjects} />
      </section>
      <section className="home-status" aria-label="等待、执行与测试状态">
        <div className="home-section-heading"><span className="section-title">当前状态</span></div>
        <article><strong>等待确认</strong>{hasPendingApproval ? <><p>有 1 个真实 Agent 修改等待你确认。</p><button className="secondary" onClick={onOpenAgent}>检查 Agent 修改</button></> : <p>当前没有等待确认的 Agent 修改。</p>}</article>
        <article><strong>执行信息</strong><p>Agent Task 执行队列尚未接入（ST-04）；这里不显示虚构的等待或运行任务。</p></article>
        <article><strong>测试与试玩</strong>{project ? <p>{publishedReleaseId ? `当前项目 ${project.title ?? project.projectId} 已有确认的发布版本，可在作品工作区试玩。` : "当前项目暂无已确认的发布试玩版本；请打开作品工作区检查真实发布状态。"}</p> : <p>选择最近项目后，可读取其真实发布试玩状态。</p>}</article>
      </section>
    </div>
  </div>;
}
