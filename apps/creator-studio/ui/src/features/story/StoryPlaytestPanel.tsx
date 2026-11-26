import { useEffect, useRef, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import { errorCode } from "../../adapters/creatorHostUtils";
import { parseCityListPage, type LibraryCityRow } from "../library/cityGameLibraryModel";
import { parseStoryInstallation, parseStoryInstallPreview, readExistingStoryRunId, readStoryRunId, storyPlaytestError,
  type StoryInstallation, type StoryInstallPreview, type StoryTarget } from "./storyPlaytestModel";

import { StoryActorControls } from "./StoryActorControls";
import { storyCharacterOptions, type StoryDocument } from "./storyEditorModel";

type CheckedInstall = Readonly<{ preview: StoryInstallPreview; operationId: string }>;

export function StoryPlaytestPanel({ request, target, blocked }: Readonly<{
  request: CreatorRequest; target: StoryTarget & Pick<StoryDocument, "canon">; blocked: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [cities, setCities] = useState<readonly LibraryCityRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cityId, setCityId] = useState("");
  const [installation, setInstallation] = useState<StoryInstallation | null>(null);
  const [installKnown, setInstallKnown] = useState(false);
  const [checked, setChecked] = useState<CheckedInstall | null>(null);
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const installationRead = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const city = cities.find(item => item.cityId === cityId);
  const installed = installKnown && installation?.contentDigest === target.contentDigest;

  const characters = storyCharacterOptions(target.canon);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await work(); }
    catch (cause) { setError(storyPlaytestError(errorCode(cause, "creator_story_playtest_unavailable"))); }
    finally { setBusy(false); }
  }

  function loadCities(cursor?: string) {
    return act(async () => {
      const next = parseCityListPage(await request("creator.city.list", { limit: 50, ...(cursor ? { cursor } : {}) }));
      setCities(current => cursor ? [...current, ...next.cities] : next.cities);
      setNextCursor(next.nextCursor);
      if (!cursor) {
        setCityId(current => next.cities.some(item => item.cityId === current) ? current
          : next.cities.length === 1 && !next.nextCursor ? next.cities[0].cityId : "");
        setRefreshKey(value => value + 1);
      }
    });
  }

  useEffect(() => {
    const generation = ++installationRead.current;
    setInstallKnown(false);
    setInstallation(null);
    setChecked(null);
    setRunId("");
    if (!open || !cityId) return;
    const scope = { cityId, storyId: target.storyId };
    void Promise.all([
      request("creator.story.install.list", { ...scope, limit: 1 }),
      request("creator.story.run.status", scope),
    ]).then(([installationResult, runResult]) => {
      if (generation !== installationRead.current) return;
      setInstallation(parseStoryInstallation(installationResult, target.storyId, cityId));
      setRunId(readExistingStoryRunId(runResult, target.storyId, cityId));
      setInstallKnown(true);
    }).catch(cause => {
      if (generation === installationRead.current) setError(storyPlaytestError(errorCode(cause, "story_installation_unavailable")));
    });
    return () => { installationRead.current++; };
  }, [open, cityId, target.storyId, request, refreshKey]);

  const inspectInstall = () => act(async () => {
    if (!city) return;
    setChecked(null);
    setStatus("");
    const value = await request("creator.story.install.preview", {
      storyId: target.storyId, targetCityId: city.cityId, expectedCityRevision: city.revision,
      operationId: crypto.randomUUID(),
    });
    setChecked({ preview: parseStoryInstallPreview(value, target, city), operationId: crypto.randomUUID() });
  });

  const install = () => act(async () => {
    if (!city || !checked?.preview.canInstall) return;
    const { preview, operationId } = checked;
    if (Date.now() >= preview.expiresAtMs) {
      setChecked(null);
      throw new Error("preview_expired");
    }
    const result = await request<{ status: string; cityId: string; storyId: string; targetPackageDigest: string }>(
      "creator.story.install.commit", { previewId: preview.previewId, operationId,
        ...(preview.updateConfirmation ? { updateConfirmation: preview.updateConfirmation } : {}) },
    );
    if (result.status !== "installed" || result.cityId !== cityId || result.storyId !== target.storyId
      || result.targetPackageDigest !== target.contentDigest) throw new Error("story_host_response_invalid");
    setInstallation({ storyVersion: target.storyVersion, contentDigest: target.contentDigest });
    setInstallKnown(true);
    setChecked(null);
    setStatus(`已安装到 ${city.name}。`);
  });

  return <section className="story-editor-section story-playtest-setup" aria-label="Story 试玩">
    <div className="home-section-heading"><h3>Story 试玩</h3>
      {!open && <button type="button" disabled={blocked} onClick={() => { setOpen(true); void loadCities(); }}>准备试玩</button>}
    </div>
    {blocked ? <p className="muted">保存当前版本后可准备新的试玩。</p>
      : !open && <p className="muted">选择一个测试 City，并连接扮演角色的 Agent。</p>}
    {open && <>
      <label>测试 City<select value={cityId} disabled={busy || !!runId || blocked} onChange={event => {
        setCityId(event.target.value); setInstallKnown(false); setChecked(null); setStatus(""); setError("");
      }}>
        <option value="">选择 City</option>
        {cities.map(item => <option key={item.cityId} value={item.cityId}>{item.name}</option>)}
      </select></label>
      <div className="actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => void loadCities()}>刷新 City</button>
        {nextCursor && <button type="button" className="secondary" disabled={busy || !!runId} onClick={() => void loadCities(nextCursor)}>加载更多 City</button>}
      </div>
      {cities.length === 0 && !busy && !error && <p>请先在 Studio 创建一个测试 City。</p>}
      {city && !installKnown && !error && <p role="status">正在检查此 City 的安装与试玩状态…</p>}
      {city && installKnown && <p>{installed ? `当前版本 ${target.storyVersion} 已安装。`
        : installation ? `已安装版本 ${installation.storyVersion}，可更新到当前保存的版本。` : "该 City 尚未安装此 Story。"}</p>}
      {runId && installKnown && <p>{!installed ? "当前试玩使用先前安装的版本。结束本次试玩后可更新。" : blocked ? "当前试玩使用已保存的版本。" : "试玩已准备。连接扮演角色的 Agent 后，在 City 中打开「Story 试玩」。"}</p>}
      <div className="actions">
        {city && installKnown && !installed && !runId && !checked?.preview.canInstall && <button type="button" disabled={busy || blocked} onClick={() => void inspectInstall()}>检查安装</button>}
        {checked?.preview.canInstall && <button type="button" disabled={busy || blocked} onClick={() => void install()}>
          {checked.preview.updateConfirmation ? "确认更新" : "确认安装"}
        </button>}
        {city && installed && !runId && <button type="button" disabled={busy || blocked} onClick={() => void act(async () => {
          const result = await request("creator.story.run.start", { cityId, storyId: target.storyId, expectedContentDigest: target.contentDigest });
          setRunId(readStoryRunId(result, target, cityId));
          setStatus("");
        })}>准备角色试玩</button>}
        {runId && <button type="button" className="secondary" disabled={busy} onClick={() => void act(async () => {
          const result = await request<{ status: string }>("creator.story.run.stop", { storyRunId: runId });
          if (result.status !== "stopped") throw new Error("story_host_response_invalid");
          setRunId("");
          setStatus("已结束本次试玩准备。");
        })}>结束这次试玩</button>}
      </div>
      {runId && installed && !blocked && <StoryActorControls key={runId} request={request} storyRunId={runId} characters={characters} />}
      {checked?.preview.diagnostics.map((item, index) => <p role="status" key={index}>{item}</p>)}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert" className="library-error">{error}</p>}
    </>}
  </section>;
}
