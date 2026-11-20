import { useState } from "react";
import type { CityDraft } from "../../contracts/cityLifecycle";

export function CityDraftPanel(props: Readonly<{
  draft: CityDraft | null;
  busy: boolean;
  browserPreview: boolean;
  onCreate: (name: string, seed: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}>) {
  const { draft, busy, browserPreview, onCreate, onCommit, onCancel } = props;
  const [name, setName] = useState("新建 City");
  const [seed, setSeed] = useState("20261117");
  const pending = draft?.status === "pending";
  return <section className="city-draft-panel" aria-label="新建 City 草稿">
    <div className="section-title">新建 City（首次保存才注册）</div>
    <p className="muted">草稿绑定名称、seed、profile 和内容摘要；取消、失败或过期不会进入正常 City 列表。</p>
    {!draft ? <>
      <label>City 名称<input value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Seed<input type="number" value={seed} disabled={busy} onChange={event => setSeed(event.target.value)} /></label>
      <div className="actions"><button disabled={busy || browserPreview || !name.trim() || !Number.isSafeInteger(Number(seed)) || Number(seed) < 0} onClick={() => onCreate(name.trim(), Number(seed))}>创建草稿</button></div>
    </> : <>
      <div className="candidate-facts"><strong>{draft.name} · {pending ? "待首次保存" : draft.status}</strong><code>{draft.contentDigest}</code><span className="muted">草稿 {draft.draftId} · 过期时间 {new Date(draft.expiresAtMs).toLocaleString("zh-CN")}</span></div>
      <div className="actions"><button disabled={!pending || busy || browserPreview} onClick={onCommit}>首次保存并注册 City</button><button className="secondary" disabled={!pending || busy || browserPreview} onClick={onCancel}>取消草稿</button></div>
    </>}
  </section>;
}
