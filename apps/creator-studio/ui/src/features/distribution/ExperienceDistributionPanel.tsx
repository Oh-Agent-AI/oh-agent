import { useCallback, useEffect, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import { errorCode } from "../../adapters/creatorHostUtils";
import { parseExperiencePackages, validExperienceVersion, type ExperiencePackageRow } from "./experienceDistributionModel";

export function ExperienceDistributionPanel(props: Readonly<{
  request: CreatorRequest;
  browserPreview: boolean;
  publishedReleaseId: string | null;
  onMessage: (message: string) => void;
}>) {
  const { request, browserPreview, publishedReleaseId, onMessage } = props;
  const [packages, setPackages] = useState<readonly ExperiencePackageRow[]>([]);
  const [releaseId, setReleaseId] = useState(publishedReleaseId ?? "");
  const [version, setVersion] = useState("1.0.0");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  useEffect(() => { if (publishedReleaseId) setReleaseId(publishedReleaseId); }, [publishedReleaseId]);
  const load = useCallback(async () => {
    if (browserPreview) return;
    setError("");
    try { setPackages(parseExperiencePackages(await request("creator.experience.list", {}))); }
    catch (cause) { setError(errorCode(cause, "creator_experience_list_unavailable")); }
  }, [browserPreview, request]);
  useEffect(() => { void load(); }, [load]);
  const build = async () => {
    if (!releaseId || !validExperienceVersion(version) || busy || browserPreview) return;
    setBusy("build"); setError("");
    try {
      await request("creator.experience.build", { releaseId, version });
      onMessage(`已从 ${releaseId} 构建不可变体验包 ${version}；尚未导出或安装。`);
      await load();
    } catch (cause) { setError(errorCode(cause, "creator_experience_build_failed")); }
    finally { setBusy(""); }
  };
  const install = async (item: ExperiencePackageRow) => {
    if (item.installed || busy || browserPreview) return;
    setBusy(`install:${item.experienceId}:${item.version}`); setError("");
    try {
      await request("creator.experience.install", { experienceId: item.experienceId, version: item.version });
      onMessage(`已校验并安装 ${item.experienceId}@${item.version} 到本机内容库；未启动、未授予远程能力。`);
      await load();
    } catch (cause) { setError(errorCode(cause, "creator_experience_install_failed")); }
    finally { setBusy(""); }
  };
  const exportPackage = async (item: ExperiencePackageRow) => {
    if (busy || browserPreview) return;
    setBusy(`export:${item.experienceId}:${item.version}`); setError("");
    try {
      await request("creator.experience.export", { experienceId: item.experienceId, version: item.version });
      onMessage(`已导出 ${item.experienceId}@${item.version}。这是未签名内容包；请只分发内容，不包含会话、日志或凭据。`);
    } catch (cause) { setError(errorCode(cause, "creator_experience_export_failed")); }
    finally { setBusy(""); }
  };
  const uninstall = async (item: ExperiencePackageRow) => {
    const key = `${item.experienceId}:${item.version}`;
    if (confirmRemove !== key || busy || browserPreview) return;
    setBusy(`remove:${key}`); setError("");
    try {
      await request("creator.experience.uninstall", { experienceId: item.experienceId, version: item.version });
      onMessage(`已从本机内容库卸载 ${item.experienceId}@${item.version}；原始构建与已发布 Release 未删除。`);
      setConfirmRemove(""); await load();
    } catch (cause) { setError(errorCode(cause, "creator_experience_uninstall_failed")); }
    finally { setBusy(""); }
  };

  return <section className="experience-distribution" aria-label="本地内容分发">
    <div className="home-section-heading"><div><span className="section-title">Experience 本地分发闭环</span><p className="muted">Release → 不可变包 → 导出/安装/卸载。没有在线商城、支付、自动更新或后台上传。</p></div><button className="secondary" disabled={busy !== "" || browserPreview} onClick={() => void load()}>刷新内容包</button></div>
    <div className="distribution-build-form"><label>已发布 Release ID<input aria-label="分发 Release ID" value={releaseId} disabled={busy !== ""} onChange={event => setReleaseId(event.target.value)} placeholder={publishedReleaseId ?? "选择已发布 Release"} /></label><label>包版本<input aria-label="体验包版本" value={version} disabled={busy !== ""} onChange={event => setVersion(event.target.value)} /></label><button disabled={busy !== "" || !releaseId || !validExperienceVersion(version) || browserPreview} onClick={() => void build()}>{busy === "build" ? "正在构建…" : "从 Release 构建内容包"}</button></div>
    {!validExperienceVersion(version) && <p className="library-error">版本必须使用 x.y.z 语义版本格式。</p>}
    <div className="library-note"><strong>信任与版权边界</strong><span>本机生成 · 未签名 · 许可/作者声明未由 Host 校验。完整性摘要不等于作者身份或分发授权；仅在你有权分享内容时导出。</span></div>
    {error && <p className="library-error" role="alert">{error}</p>}
    {packages.length === 0 ? <p className="muted">尚无 Experience 内容包。先选择真实已发布 Release 并构建。</p> : <div className="experience-package-list">{packages.map(item => {
      const key = `${item.experienceId}:${item.version}`;
      return <article key={key} className="experience-package-card"><div className="library-card-top"><span className="resource-kind">CITY EXPERIENCE</span><span className="validation">{item.installed ? "已安装到本机" : "已构建，未安装"}</span></div>
        <strong>{item.experienceId}@{item.version}</strong><code>{item.contentDigest}</code>
        <p>来源 Release {item.releaseId ?? "未知"} · 类型 {item.gameType ?? "未知"} · {item.fileCount} 个文件</p><p className="muted">未签名 · 许可未声明 · 仅本地/可信来源分发</p>
        <div className="actions"><button className="secondary" disabled={busy !== "" || browserPreview} onClick={() => void exportPackage(item)}>导出副本…</button>
          {!item.installed ? <button disabled={busy !== "" || browserPreview} onClick={() => void install(item)}>校验并安装到本机</button> : <button className="secondary" disabled={busy !== "" || browserPreview} onClick={() => { if (confirmRemove === key) void uninstall(item); else setConfirmRemove(key); }}>{confirmRemove === key ? "确认从本机卸载" : "卸载本机副本"}</button>}
        </div>{confirmRemove === key && item.installed && <p className="muted">再次点击才会卸载；不会删除原始构建、Release 或已有玩家 Run。</p>}</article>;
    })}</div>}
  </section>;
}
