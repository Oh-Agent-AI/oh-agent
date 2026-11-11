import { useEffect, useRef, useState } from "react";
import type { DreamCitySnapshotV1 } from "./dreamSnapshotContract";
import type { DreamSnapshotEnvelopeV1 } from "./dreamSnapshotCodec";
import { RemoteDreamCityScene } from "./RemoteCityScene";
import { DreamOwnerRemoteClient, type DreamOwnerSession, type DreamPendingVisitor } from "./DreamOwnerRemoteClient";
import "./dreamSnapshotPreview.css";

export function DreamSnapshotPreview({ open, snapshot, envelope, plainBytes, envelopeBytes, busy, error, onClose, onPublicationActive }: {
  open: boolean;
  snapshot: DreamCitySnapshotV1 | null;
  envelope: DreamSnapshotEnvelopeV1 | null;
  plainBytes: number | null;
  envelopeBytes: number | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onPublicationActive: (active: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const owner = useRef(new DreamOwnerRemoteClient());
  const [relay, setRelay] = useState(() => sessionStorage.getItem("agent-city-relay") ?? "");
  const [consentScene, setConsentScene] = useState(false);
  const [consentTransport, setConsentTransport] = useState(false);
  const [consentSceneFor, setConsentSceneFor] = useState<DreamCitySnapshotV1 | null>(null);
  const [consentTransportFor, setConsentTransportFor] = useState<DreamCitySnapshotV1 | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publication, setPublication] = useState<DreamOwnerSession | null>(null);
  const [pending, setPending] = useState<DreamPendingVisitor[]>([]);
  const [approved, setApproved] = useState<DreamPendingVisitor[]>([]);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // Consent is tied to the exact local snapshot. A regenerated snapshot
    // requires the owner to review and approve its contents again.
    setConsentScene(false);
    setConsentTransport(false);
    setConsentSceneFor(null);
    setConsentTransportFor(null);
  }, [snapshot]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => { onPublicationActive(Boolean(publication)); }, [publication, onPublicationActive]);

  useEffect(() => {
    if (!open || !publication) return;
    let active = true;
    const refresh = async () => {
      try { const next = await owner.current.pending(publication.sessionId); if (active) setPending(next); }
      catch (cause) { if (active) setShareError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [open, publication]);

  const createPublication = async () => {
    if (!snapshot || !envelope || !consentScene || !consentTransport
        || consentSceneFor !== snapshot || consentTransportFor !== snapshot || publishing) return;
    setPublishing(true); setShareError(null);
    try {
      const result = await owner.current.start({ relay: relay.trim(), envelope, confirmed: true });
      setPublication(result); setPending([]); setApproved([]); setCopied(false);
      sessionStorage.setItem("agent-city-relay", relay.trim().replace(/\/$/, ""));
    } catch (cause) { setShareError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    finally { setPublishing(false); }
  };

  const renewInvite = async () => {
    if (!publication) return;
    setPublishing(true); setShareError(null);
    try { setPublication(await owner.current.invite(publication.sessionId)); setCopied(false); }
    catch (cause) { setShareError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    finally { setPublishing(false); }
  };

  const setVisitorAccess = async (visitor: DreamPendingVisitor, action: "approve" | "revoke") => {
    if (!publication) return;
    setShareError(null);
    try {
      await owner.current[action](publication.sessionId, visitor.deviceId);
      setApproved(current => action === "approve"
        ? [...current.filter(item => item.deviceId !== visitor.deviceId), visitor]
        : current.filter(item => item.deviceId !== visitor.deviceId));
      setPending(current => current.filter(item => item.deviceId !== visitor.deviceId));
      if (action === "approve") setShareError(null);
    } catch (cause) { setShareError(cause instanceof Error ? cause.message : "remote_unavailable"); }
  };

  const stopPublication = async () => {
    if (!publication || publishing) return;
    setPublishing(true); setShareError(null);
    try { await owner.current.stop(publication.sessionId); setPublication(null); setPending([]); setApproved([]); setConsentScene(false); setConsentTransport(false); }
    catch (cause) { setShareError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    finally { setPublishing(false); }
  };

  const close = () => onClose();
  return <dialog ref={dialog} className="city-dialog city-dream-preview-dialog" aria-label="梦境城市本机预览"
    onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => { if (open) close(); }}>
    <header className="city-dialog-header">
      <div><h2>访客城市预览与分享</h2><p>{publication ? "当前快照已固定发布；后续本机城市变化不会自动更新访客场景。" : "快照先在本机生成。只有你完成下面的确认并点击创建链接后，才会发送到所选中继。"}</p></div>
      <button className="city-close" aria-label="关闭梦境预览" onClick={close}>×</button>
    </header>
    <div className="city-dialog-body dream-snapshot-body">
      <section className="dream-snapshot-scene" aria-label="访客视角三维预览">
        {snapshot && <RemoteDreamCityScene snapshot={snapshot.snapshot} palettes={snapshot.palettes} heroBuildingId={snapshot.heroBuildingId} />}
        {!snapshot && <p role={error ? "alert" : "status"}>{error ?? (busy ? "正在生成并校验访客快照…" : "等待生成快照")}</p>}
      </section>
      <aside className="dream-snapshot-details">
        <h3>本次投影范围</h3>
        <ul>
          <li>会分享当前城市的已应用地形、道路、建筑位置/大小、设施、背景楼和发布者当前视角，以及城市/区域/建筑的会话数、活跃状态和 token 用量。</li>
          <li>会分享经过清理并限制长度的建筑会话标题及标题来源类别。标题内容仍可能包含你不希望访客看到的信息；请先检查本机城市再发布。</li>
          <li>不会分享原始会话标识、成本、日志、文件路径或提示词。城市布局本身也可能反映使用规模与大致时间顺序。</li>
          <li>快照中的实体 ID 由本机可信 City 适配器按发布随机生成，并在分享前再次校验。</li>
        </ul>
        {snapshot && <dl>
          <dt>本地捕获序号</dt><dd>{snapshot.revision}</dd>
          <dt>原始快照</dt><dd>{plainBytes === null ? "—" : `${plainBytes.toLocaleString()} 字节`}</dd>
          <dt>压缩消息</dt><dd>{envelopeBytes === null ? "超出当前消息预算或压缩不可用" : `${envelopeBytes.toLocaleString()} 字节`}</dd>
        </dl>}
        {busy && <p role="status">正在进行本机字段校验、随机匿名化和压缩…</p>}
        {error && <p role="alert">{error}</p>}
        {!publication && <section className="dream-publication-controls" aria-label="发布者授权">
          <h3>创建远程城市链接</h3>
          <label>中继地址<input type="url" value={relay} disabled={publishing} onChange={event => setRelay(event.currentTarget.value)} placeholder="https://relay.example" autoComplete="url" /></label>
          <label className="dream-consent"><input type="checkbox" checked={consentScene} disabled={!snapshot || busy || publishing} onChange={event => { const checked = event.currentTarget.checked; setConsentScene(checked); setConsentSceneFor(checked ? snapshot : null); }} />我已查看本机城市，理解会分享建筑会话标题、标题来源、城市/区域/建筑会话数、活跃状态和 token 用量，并同意将这些字段及当前城市布局发送给访客。</label>
          <label className="dream-consent"><input type="checkbox" checked={consentTransport} disabled={!snapshot || busy || publishing} onChange={event => { const checked = event.currentTarget.checked; setConsentTransport(checked); setConsentTransportFor(checked ? snapshot : null); }} />我了解场景通过 TLS 中继传输，但未启用端到端加密；持有邀请链接的人可申请访问，每位访客需由我批准。</label>
          <button type="button" disabled={!snapshot || !envelope || busy || publishing || !consentScene || !consentTransport || consentSceneFor !== snapshot || consentTransportFor !== snapshot} onClick={() => void createPublication()}>{publishing ? "正在创建…" : "确认并生成访客链接"}</button>
        </section>}
        {publication && <section className="dream-publication-controls" aria-label="远程访客管理">
          <h3>远程访问已开启</h3>
          <p>邀请链接有效 {Math.ceil(publication.expiresIn / 60)} 分钟。你可以复制并分享；访问申请需逐个批准。</p>
          <textarea aria-label="访客邀请链接" readOnly value={publication.inviteUrl} />
          <div className="dream-publication-actions">
            <button type="button" disabled={publishing} onClick={() => { void navigator.clipboard?.writeText(publication.inviteUrl).then(() => setCopied(true)).catch(() => setShareError("clipboard_unavailable")); }}>{copied ? "已复制" : "复制邀请链接"}</button>
            <button type="button" disabled={publishing} onClick={() => void renewInvite()}>生成新邀请链接</button>
            <button type="button" disabled={publishing} onClick={() => void stopPublication()}>关闭远程访问</button>
          </div>
          <h4>等待批准 · {pending.length}</h4>
          {pending.length ? pending.map(visitor => <div className="dream-visitor-row" key={visitor.deviceId}><span>访客设备 · {visitor.deviceId.slice(0, 8)}</span><button type="button" disabled={publishing} onClick={() => void setVisitorAccess(visitor, "approve")}>批准</button><button type="button" disabled={publishing} onClick={() => void setVisitorAccess(visitor, "revoke")}>拒绝</button></div>) : <p>暂无待处理申请。</p>}
          <h4>已批准 · {approved.length}</h4>
          {approved.map(visitor => <div className="dream-visitor-row" key={visitor.deviceId}><span>访客设备 · {visitor.deviceId.slice(0, 8)}</span><button type="button" disabled={publishing} onClick={() => void setVisitorAccess(visitor, "revoke")}>撤销</button></div>)}
        </section>}
        {shareError && <p role="alert">远程操作失败：{shareError}</p>}
        <p className="dream-snapshot-notice">Relay 仅负责授权与实时转发，场景正文不应持久化；传输使用 TLS，不代表端到端加密。停止发布会关闭现有访客连接。</p>
      </aside>
    </div>
    <footer className="city-dialog-actions"><button onClick={close}>关闭预览面板</button></footer>
  </dialog>;
}
