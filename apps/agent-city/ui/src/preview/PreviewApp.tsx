import { useEffect, useMemo, useRef, useState } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { CityActivityCoordinator } from "../game/activity/CityActivityCoordinator";
import { CodeGameDialogue } from "../game/codeGameHost/CodeGameDialogue";
import { useCodeGamePreview } from "../game/codeGameHost/useCodeGamePreview";
import { CityViewport } from "../viewport/CityViewport";
import { readCodePreviewBoot } from "./boot";
import "./preview.css";

type ViewportStatus = "loading" | "ready" | "failed";

export function PreviewApp() {
  const boot = useMemo(readCodePreviewBoot, []);
  const engineRef = useRef<CityEngine | null>(null);
  const [coordinator] = useState(() => new CityActivityCoordinator());
  const preview = useCodeGamePreview({ engineRef, coordinator });
  const { startNextPreview, stop } = preview;
  const [viewportStatus, setViewportStatus] = useState<ViewportStatus>("loading");
  const [viewportFailure, setViewportFailure] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    if (!boot.ok) return;
    let active = true;
    let busy = false;
    let started = false;
    const poll = async () => {
      if (!active || busy) return;
      busy = true;
      try {
        const accepted = await startNextPreview();
        started ||= accepted;
        if (active && !accepted && !started) setLaunchError("没有可启动的已排队 Code Game 构建，请从 Creator Studio 重新发起预览。");
      } catch (error) {
        if (active) setLaunchError(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
      }
    };
    const close = () => stop();
    window.addEventListener("pagehide", close);
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", close);
      stop();
    };
  }, [boot, startNextPreview, stop]);

  if (!boot.ok) {
    return <main className="code-preview code-preview--unavailable">
      <section className="code-preview-status is-error" role="alert">
        <strong>无法启动独立 Preview</strong>
        <p>{boot.error}</p>
      </section>
    </main>;
  }

  const { source } = boot.value;
  const gameError = preview.state.status === "error" ? preview.state.error ?? "Code Game 启动失败。" : null;
  const error = launchError ?? gameError ?? (viewportStatus === "failed" ? `独立城市加载失败（${viewportFailure ?? "city_preview_failed"}）。` : null);
  const status = error ? "error" : preview.state.status === "finished" ? "finished" : preview.state.status === "running" ? "running" : "waiting";
  const title = status === "error" ? "Preview 错误" : status === "finished" ? "Preview 已完成" : status === "running" ? "Code Game 运行中" : preview.state.status === "starting" ? "正在启动 Code Game" : viewportStatus === "ready" ? "等待已排队构建" : "正在准备独立城市";
  const detail = error ?? (status === "finished" ? preview.state.reason ?? "游戏 Run 已结束。" : preview.state.status === "starting" ? "正在读取构建包并启动游戏 Run。" : viewportStatus === "ready" ? "正在从 Preview 队列接收构建。" : "正在创建只用于本次 Preview 的城市与布局。");

  return <main className="code-preview">
    <CityViewport
      seed={source.seed}
      worldProfile={source.profile}
      isolatedDraft
      isolatedProjectPatch={source.planPatch}
      editable={false}
      registerProbe={false}
      onEngineChange={(engine) => { engineRef.current = engine; }}
      onViewportStatus={(next, failureCode) => {
        setViewportStatus(next);
        setViewportFailure(next === "failed" ? failureCode ?? null : null);
      }}
    />
    <header className="code-preview-header">
      <div>
        <p>CODE GAME · INDEPENDENT PREVIEW</p>
        <h1>独立引擎预览</h1>
      </div>
      <span className={`code-preview-badge is-${status}`}>{title}</span>
    </header>
    <div className="code-preview-source">
      <span>{source.synthetic ? "合成城市" : "City Registry 快照"}</span>
      <code>{source.cityId}</code>
      <span>Seed {source.seed}</span>
    </div>
    {status !== "running" && <section className={`code-preview-status is-${status}`} role={status === "error" ? "alert" : "status"} aria-live="polite">
      <strong>{title}</strong>
      <p>{detail}</p>
      {preview.state.runId && <code>Run {preview.state.runId}</code>}
    </section>}
    <footer className="code-preview-footer">独立引擎与预览玩家 · 不替换主 City · 正式 Story 写入未开放</footer>
    {preview.dialogue && <CodeGameDialogue dialogue={preview.dialogue} language="zh-Hans" onChoice={preview.chooseDialogue} onClose={preview.closeDialogue} />}
  </main>;
}
