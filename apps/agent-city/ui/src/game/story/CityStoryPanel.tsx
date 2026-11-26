import { useEffect, useRef, useState } from "react";
import { completeCityStory, commitCityStory, listPreparedCityStories, readCityStoryRun, readCityTime, startCityGameRun, stopCityGameRun,
  type CityStoryCompletionAction, type CityStoryRunView, type PreparedCityStory } from "../codeGameHost/cityRuntimeCalls";
import "./cityStoryPanel.css";

type OpenStory = Readonly<{ story: PreparedCityStory; runId: string }>;
type Speech = Parameters<typeof commitCityStory>[0];

function problem(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "city_story_unavailable";
  if (code === "game_activity_busy") return "当前 City 正在进行其他活动，请先退出该活动。";
  if (code === "game_storage_revision_conflict" || code === "city_time_revision_conflict") return "故事进度已更新，请查看最新对白后重试。";
  if (code === "story_ending_required") return "故事尚未到达结局，请继续当前回合。";
  if (code === "game_run_cancelled") return "本次试玩已关闭。重新打开可继续当前进度。";
  if (code === "story_run_not_active") return "这个故事回合已结束，请在 Studio 重新准备。";
  return `Story 操作失败（${code}）。`;
}

export function CityStoryPanel({ onClose }: Readonly<{ onClose: () => void }>) {
  const [available, setAvailable] = useState<readonly PreparedCityStory[]>([]);
  const [current, setCurrent] = useState<OpenStory | null>(null);
  const [snapshot, setView] = useState<CityStoryRunView | null>(null);
  const view = snapshot?.storyRunId === current?.story.storyRunId ? snapshot : null;
  const [characterId, setCharacterId] = useState("");
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState<{ eventId: string; deadline: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const retrySpeech = useRef<Speech | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const characters = view?.presentation?.characters ?? [];
  const character = characters.find(item => item.id === characterId) ?? characters[0];
  const ended = view?.presentation?.beat?.kind === "ending";

  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await work(); }
    catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    let open = true;
    void listPreparedCityStories()
      .then(rows => { if (open) setAvailable(rows); })
      .catch(cause => { if (open) setError(problem(cause)); })
      .finally(() => { if (open) setBusy(false); });
    return () => { open = false; };
  }, []);

  useEffect(() => {
    if (!current) return;
    let open = true;
    let next: ReturnType<typeof setTimeout>;
    async function poll(story: OpenStory) {
      try {
        const snapshot = await readCityStoryRun(story.runId);
        if (!open) return;
        if (snapshot.storyRunId !== story.story.storyRunId) throw new Error("story_run_mismatch");
        setView(snapshot);
        setRefreshError("");
        setWaiting(value => value && (snapshot.presentation?.beat?.kind === "ending"
          || snapshot.dialogue.some(line => line.replyToEventId === value.eventId)) ? null : value);
      } catch (cause) {
        if (open) setRefreshError(problem(cause));
      } finally {
        if (open) next = setTimeout(() => void poll(story), 1_500);
      }
    }
    void poll(current);
    return () => { open = false; clearTimeout(next); };
  }, [current]);

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setWaiting(null);
      setError("Actor 暂未回复。已发送的消息会保留，收到回复后会显示在对话中。");
    }, Math.max(0, waiting.deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [waiting]);

  const enter = (story: PreparedCityStory) => action(async () => {
    const run = await startCityGameRun({ cityId: story.cityId, gameId: story.storyId, storyRunId: story.storyRunId });
    if (!run || run.storyRunId !== story.storyRunId) throw new Error("story_run_mismatch");
    setCurrent({ story, runId: run.runId });
  });

  const send = () => action(async () => {
    if (!current || !view || !character || waiting || ended) return;
    const text = draft.trim();
    if (!text) return;
    let speech = retrySpeech.current;
    if (!speech || speech.intent.text !== text || speech.residentId !== character.id) {
      const clock = await readCityTime(current.story.cityId);
      if (!clock) throw new Error("city_time_unavailable");
      speech = {
        runId: current.runId, operationId: crypto.randomUUID(), eventId: crypto.randomUUID(),
        expectedStoryRevision: view.storyRevision, expectedClockRevision: clock.clockRevision, residentId: character.id,
        intent: { kind: "speak", text, residentId: character.id },
      };
      retrySpeech.current = speech;
    }
    try {
      await commitCityStory(speech);
    } catch (cause) {
      if (cause instanceof Error && ["game_storage_revision_conflict", "city_time_revision_conflict"].includes(cause.message)) {
        retrySpeech.current = null;
      }
      throw cause;
    }
    retrySpeech.current = null;
    setDraft("");
    setWaiting({ eventId: speech.eventId, deadline: Date.now() + 35_000 });
  });

  const complete = (choice: CityStoryCompletionAction) => {
    if (busy || !current || !ended) return;
    void action(async () => {
      const result = await completeCityStory(current.runId, choice);
      const sameRun = result.runId === current.runId && result.storyRunId === current.story.storyRunId;
      const newRun = result.runId !== current.runId && result.storyRunId !== current.story.storyRunId;
      if (result.action !== choice || !result.runId || !result.storyRunId || (choice === "finish" ? !sameRun : !newRun)) {
        throw new Error("story_run_mismatch");
      }
      if (choice === "finish") {
        onClose();
        return;
      }
      retrySpeech.current = null;
      setView(null);
      setDraft("");
      setWaiting(null);
      setCharacterId("");
      setRefreshError("");
      setCurrent({ runId: result.runId, story: { ...current.story, storyRunId: result.storyRunId } });
    });
  };

  const close = () => {
    if (busy) return;
    void action(async () => {
      if (current) await stopCityGameRun(current.runId);
      onClose();
    });
  };

  return <dialog ref={dialogRef} className="city-story-panel" aria-labelledby="city-story-title" onCancel={event => {
    event.preventDefault();
    close();
  }}>
      <header>
        <div><h2 id="city-story-title">{current?.story.title ?? "Story 试玩"}</h2>
          {current && <p>{current.story.cityName} · {current.story.storyVersion}</p>}</div>
        <button type="button" disabled={busy} onClick={close}>{current ? "退出试玩" : "关闭"}</button>
      </header>
      {!current && <div className="city-story-list">
        {busy && <p role="status">正在读取 Story…</p>}
        {!busy && available.length === 0 && !error && <p>请先在 Creator Studio 安装 Story 并准备试玩回合。</p>}
        <button type="button" disabled={busy} onClick={() => void action(async () => setAvailable(await listPreparedCityStories()))}>刷新列表</button>
        {available.map(story => <button key={story.storyRunId} type="button" disabled={busy} onClick={() => void enter(story)}>
          <strong>{story.title}</strong><span>{story.cityName} · {story.storyVersion}</span>
        </button>)}
      </div>}
      {current && <>
        {view?.presentation?.beat?.title && <p className="city-story-beat">{view.presentation.beat.title}</p>}
        {!view && !refreshError && <p role="status">正在读取剧情…</p>}
        <ol className="city-story-dialogue" aria-label="剧情对白" aria-live="polite">
          {[...(view?.dialogue ?? [])].reverse().map(line => <li key={line.eventId}>
            <strong>{line.replyToEventId ? "Actor" : "玩家"}</strong> {line.intent.text}
          </li>)}
        </ol>
        {ended ? <>
          <p role="status" className="city-story-ending">已到达结局</p>
          <div className="city-story-actions">
            <button type="button" disabled={busy} onClick={() => complete("finish")}>结束故事</button>
            <button type="button" disabled={busy} onClick={() => complete("restart")}>重新开始</button>
          </div>
        </> : view && <>
          {character ? <form onSubmit={event => { event.preventDefault(); void send(); }}>
            <label>对话角色<select value={character.id} disabled={busy || !!waiting} onChange={event => setCharacterId(event.target.value)}>
              {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label>对白<textarea rows={2} value={draft} maxLength={500} disabled={busy || !!waiting} onChange={event => setDraft(event.target.value)} /></label>
            <button type="submit" disabled={busy || !!waiting || !draft.trim()}>发送</button>
          </form> : <p>该 Story 暂无可对话角色。</p>}
          {waiting && <p role="status">等待 Actor 回复…</p>}
        </>}
      </>}
      {refreshError && <p role="status">{refreshError} 正在尝试重新读取。</p>}
      {error && <p role="alert">{error}</p>}
  </dialog>;
}
