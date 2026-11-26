import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectRow } from "../../contracts/creatorStudio";
import { normalizeStudioGoal } from "../../contracts/studioTask";

export type CatalogStartMode = "agent" | "new" | "agent-new" | null;

export function CatalogStart({ mode, projects, busy, goal, onGoalChange, onModeChange, onOpen, gameForm }: Readonly<{
  mode: CatalogStartMode;
  projects: readonly ProjectRow[];
  busy: boolean;
  goal: string;
  onGoalChange: (goal: string) => void;
  onModeChange: (mode: CatalogStartMode) => void;
  onOpen: (projectId: string) => void;
  gameForm: ReactNode;
}>) {
  const [projectId, setProjectId] = useState("");
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode === "agent") goalInput.current?.focus();
  }, [mode]);
  const selected = projects.some(project => project.projectId === projectId) ? projectId : "";
  const hasGoal = !!normalizeStudioGoal(goal);
  return <section className={mode === null ? "catalog-start is-collapsed" : "catalog-start"} aria-labelledby="catalog-start-title">
    <div className="catalog-start-heading">
      <div>
        <h2 id="catalog-start-title">{mode === "new" ? "新建 Game 项目" : "用一句话开始创作"}</h2>
        {mode !== "new" && <p>写下想做的事，选一个 Game 项目，进入编辑器确认计划。</p>}
      </div>
      {mode === null
        ? <button ref={openButton} className="catalog-primary" disabled={busy} onClick={() => onModeChange("agent")}>让 Agent 帮我开始</button>
        : <button className="catalog-secondary" disabled={busy} onClick={() => {
          onModeChange(null);
          window.requestAnimationFrame(() => openButton.current?.focus());
        }}>收起</button>}
    </div>
    {mode !== null && mode !== "new" && <>
      <label>创作目标<textarea ref={goalInput} rows={2} maxLength={4000} value={goal} disabled={busy}
        onChange={event => onGoalChange(event.target.value)} placeholder="例如，把海滨公路做成检查点竞速" /></label>
      {mode === "agent" && <form className="catalog-start-actions" onSubmit={event => {
        event.preventDefault();
        if (!busy && selected && hasGoal) onOpen(selected);
      }}>
        {projects.length > 0 && <>
          <label>使用已有项目<select value={selected} disabled={busy} onChange={event => setProjectId(event.target.value)}>
            <option value="" disabled>选择 Game 项目</option>
            {projects.map(project => <option key={project.projectId} value={project.projectId}>{project.title}</option>)}
          </select></label>
          <button className="catalog-primary" type="submit" disabled={!selected || !hasGoal || busy}>带目标进入编辑器</button>
        </>}
        <button className={projects.length > 0 ? "catalog-secondary" : "catalog-primary"} type="button"
          disabled={busy || !hasGoal} onClick={() => onModeChange("agent-new")}>新建项目并继续</button>
      </form>}
    </>}
    {(mode === "new" || mode === "agent-new") && gameForm}
    {mode === "agent-new" && projects.length > 0 && <button className="catalog-secondary" disabled={busy} onClick={() => onModeChange("agent")}>改用已有项目</button>}
  </section>;
}
