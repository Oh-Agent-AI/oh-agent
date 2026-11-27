import type { GroundInspection } from "../evidence/evidenceCenterModel";
import type { EntityVerificationLevel, PreviewEntityReference, PreviewEntityReferenceStatus } from "../../contracts/previewContext";

export type PreviewEntityDiagnosticState = Readonly<{
  status: "idle" | "loading" | "ready" | "unsupported" | "failed";
  inspection?: GroundInspection;
  error?: string;
  persisted?: boolean;
}>;

export const idlePreviewEntityDiagnostic: PreviewEntityDiagnosticState = { status: "idle" };

// 三级验证的展示词：客户端回报成功只到「试玩通过」，永远不显示「Host 验证通过」。
export function entityVerificationLabel(level: EntityVerificationLevel): string {
  return level === "host-verified" ? "Host 验证通过"
    : level === "client-reported" ? "试玩通过 · City 客户端回报（非 Host 验证）"
    : "未验证";
}

export function PreviewEntityChip(props: Readonly<{
  reference: PreviewEntityReference;
  status: PreviewEntityReferenceStatus;
  verification: EntityVerificationLevel;
  onClear: () => void;
  onFocus: () => void;
}>) {
  const { reference, status, verification, onClear, onFocus } = props;
  return <div className={`preview-entity-chip ${status === "current" ? "" : "stale"}`} aria-label="Preview 对象上下文">
    <div><span>对象上下文</span><strong>{reference.label}</strong><code>{reference.entityId}</code></div>
    <p>{status === "current" ? "已绑定当前版本" : status === "stale" ? "对象版本已过期，请重新选择" : "对象不属于当前 Project，请重新选择"}</p>
    <small>Project revision {reference.projectRevision} · City revision {reference.cityRevision} · World {reference.worldRevision}</small>
    {verification !== "none" && <span className="preview-entity-verified">{entityVerificationLabel(verification)}</span>}
    <div className="actions"><button className="secondary" disabled={status !== "current"} onClick={onFocus}>定位对象</button><button className="secondary" onClick={onClear}>移除</button></div>
  </div>;
}

export function PreviewEntityDiagnosticCard(props: Readonly<{
  reference: PreviewEntityReference;
  status: PreviewEntityReferenceStatus;
  verification: EntityVerificationLevel;
  diagnostic: PreviewEntityDiagnosticState;
  onInspect: () => void;
  onFocus: () => void;
}>) {
  const { reference, status, verification, diagnostic, onInspect, onFocus } = props;
  const inspection = diagnostic.inspection;
  const verificationNote = verification === "host-verified"
    ? "Host 验证通过：同实体、同 Project/City/World 版本的诊断已写入 Task Ledger，并通过 Host 可信检查。"
    : verification === "client-reported"
      ? "试玩通过：同版本诊断已写入 Task Ledger，来源为 City 客户端回报——未经 Host 独立验证，不能当作发布级验证通过。"
      : "诊断证据尚未写入当前 Task Ledger；不会仅凭这段结果显示“已验证”。";
  return <section className="preview-entity-diagnostic" aria-label="对象诊断">
    <div className="preview-entity-diagnostic-head"><div><span>当前对象</span><strong>{reference.label}</strong></div><button className="secondary" onClick={onFocus}>定位</button></div>
    <code>{reference.entityId}</code>
    {status !== "current" && <p className="library-error">对象上下文已过期，请在 Preview 重新选择，不能按同名对象继续。</p>}
    {diagnostic.status === "idle" && <p>可直接查询当前渲染 City 的真实支撑面；不需要先打开调试标签。</p>}
    {diagnostic.status === "loading" && <p role="status">正在读取当前世界的四轮支撑与承托面…</p>}
    {diagnostic.status === "failed" && <p className="library-error" role="alert">{diagnostic.error ?? "诊断不可用"}</p>}
    {inspection && <div className="preview-diagnostic-summary" role="status">
      <strong>{inspection.status === "ready" ? "真实接地诊断已返回" : `未形成合法支撑：${inspection.code ?? "未知原因"}`}</strong>
      <p>{verificationNote}</p>
      <details><summary>查看详情</summary><dl>
        <div><dt>Layout World Revision</dt><dd>{reference.worldRevision}</dd></div>
        <div><dt>Surface World Revision</dt><dd>{inspection.worldRevision ?? "未知"}</dd></div>
        <div><dt>Region / Surface</dt><dd>{inspection.regionId ?? "未知"} / {inspection.layerId ?? "未知"}</dd></div>
        <div><dt>中心高度</dt><dd>{inspection.y?.toFixed(4) ?? "未知"} m</dd></div>
        <div><dt>四轮接触</dt><dd>{inspection.wheels.length === 4 ? inspection.wheels.map(value => value.toFixed(4)).join(" / ") : "未解析"}</dd></div>
      </dl></details>
    </div>}
    <div className="actions"><button disabled={status !== "current" || diagnostic.status === "loading"} onClick={onInspect}>检查真实接地</button></div>
  </section>;
}
