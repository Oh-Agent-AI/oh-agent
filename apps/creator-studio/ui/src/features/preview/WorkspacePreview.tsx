import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkspaceAction, WorkspaceStep } from "./workspaceNextStep";
import "./workspacePreview.css";

export function WorkspacePreview({ children, title, saveStatus, step, busy, hasProject, browserPreview, playtest, diagnostics, releaseRequest, contentOpen, onCloseContent, toolPanel, onAction, onOpenStory, onOpenCity, storyActive, focus, onToggleFocus }: Readonly<{
  children: ReactNode;
  contentOpen: boolean;
  onCloseContent: () => void;
  toolPanel?: ReactNode;
  title: string;
  saveStatus: string | null;
  step: WorkspaceStep;
  busy: boolean;
  hasProject: boolean;
  browserPreview: boolean;
  releaseRequest: number;
  playtest: ReactNode;
  diagnostics: ReactNode;
  onAction: (action: Exclude<WorkspaceAction, "details">) => void;
  onOpenStory: () => void;
  onOpenCity: () => void;
  storyActive: boolean;
  /** 布局模式：preview = 收起 Session 与对话，预览占满（设计基线 §1）。 */
  focus: "balanced" | "preview";
  onToggleFocus: () => void;
}>) {
  const [open, setOpen] = useState<"playtest" | "diagnostics" | null>(null);
  const previewHeading = useRef<HTMLDivElement>(null);
  const contentWasOpen = useRef(contentOpen);
  useEffect(() => {
    if (contentOpen) setOpen(null);
    if (!contentOpen && contentWasOpen.current && document.activeElement === document.body) previewHeading.current?.focus();
    contentWasOpen.current = contentOpen;
  }, [contentOpen]);
  const details = useRef<HTMLDivElement>(null);
  const handledRelease = useRef(releaseRequest);
  useEffect(() => {
    if (handledRelease.current === releaseRequest) return;
    handledRelease.current = releaseRequest;
    if (hasProject) { setOpen("playtest"); window.requestAnimationFrame(() => details.current?.focus()); }
  }, [releaseRequest, hasProject]);
  const drawer = contentOpen ? null : open;
  const action = step.action;
  const activeTab = storyActive ? "story" : open === "playtest" ? "game" : open === "diagnostics" ? "tests" : "city";
  const selectTab = (tab: "city" | "story" | "game" | "tests") => {
    if (tab === "story") { setOpen(null); onOpenStory(); return; }
    onOpenCity();
    setOpen(tab === "game" ? "playtest" : tab === "tests" ? "diagnostics" : null);
  };
  return <section className="workspace-preview" aria-label="游戏预览工作区">
    <div ref={previewHeading} tabIndex={-1} className="workspace-preview-heading">
      <div className="workspace-preview-identity">
        <strong title={title}>{title}</strong>
        {saveStatus && <span>{saveStatus}</span>}
      </div>
      <span role="status">{step.status}</span>
      {action && step.label && <button className="workspace-next-action" type="button" disabled={busy}
        onClick={() => {
          if (action !== "details") { onAction(action); return; }
          onCloseContent();
          setOpen("playtest");
          window.requestAnimationFrame(() => details.current?.focus());
        }}>{step.label}</button>}
      <button className="workspace-focus-toggle" type="button" aria-pressed={focus === "preview"}
        onClick={onToggleFocus}>{focus === "preview" ? "返回三栏" : "全屏预览"}</button>
    </div>
    <div className="workspace-preview-canvas">{children}</div>
    {toolPanel}
    <div className="workspace-preview-dock" role="tablist" aria-label="Live Preview">
      {(["city", "story", "game", "tests"] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={activeTab === tab}
        aria-expanded={tab === "game" || tab === "tests" ? drawer === (tab === "game" ? "playtest" : "diagnostics") : undefined}
        onClick={() => selectTab(tab)}>{tab === "city" ? "City" : tab === "story" ? "Story" : tab === "game" ? "Game" : "Tests"}</button>)}
      <span>{step.evidence ?? (browserPreview ? "浏览器场景预览 · 合成数据" : hasProject ? "试玩使用固定版本" : "")}</span>
    </div>
    <div ref={details} tabIndex={-1} id="workspace-preview-details" className="workspace-preview-details" hidden={!drawer}>
      {drawer === "playtest" && playtest}
      {drawer === "diagnostics" && diagnostics}
    </div>
  </section>;
}
