import { useEffect, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import { errorCode } from "../../adapters/creatorHostUtils";
import type { StoryEdgeV2, StoryNodeV1 } from "@oh-agent/narrative-sdk";
import { parseStoryProjects, type StoryProjectRow } from "../library/cityGameLibraryModel";
import {
  newStoryDocument, parseStoryDocument, storyDocumentDiagnostics, storySavePayload, testStoryConditions,
  type StoryDocument,
} from "./storyEditorModel";

function JsonField(props: Readonly<{
  label: string;
  value: unknown;
  errorKey: string;
  onChange: (value: unknown) => void;
  onError: (key: string, message: string) => void;
}>) {
  const { label, value, errorKey, onChange, onError } = props;
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  useEffect(() => { setText(JSON.stringify(value, null, 2)); setError(""); onError(errorKey, ""); }, [value, errorKey]);
  return <label>{label}<textarea className="story-json-field" value={text} onChange={event => {
    const next = event.target.value; setText(next);
    try { onChange(JSON.parse(next)); setError(""); onError(errorKey, ""); }
    catch { setError("JSON 格式无效；当前内容尚未应用到草稿。"); onError(errorKey, "invalid_json"); }
  }} />{error && <span className="story-field-error" role="alert">{error}</span>}</label>;
}

function GraphNodeEditor({ node, index, onChange, onRemove }: Readonly<{
  node: StoryNodeV1; index: number; onChange: (node: StoryNodeV1) => void; onRemove: () => void;
}>) {
  return <div className="story-node-row">
    <input aria-label={`节点 ${index + 1} ID`} value={node.id} onChange={event => onChange({ ...node, id: event.target.value })} />
    <select aria-label={`节点 ${index + 1} 类型`} value={node.kind} onChange={event => onChange({ ...node, kind: event.target.value })}><option value="beat">剧情 Beat</option><option value="choice">选择</option><option value="ending">结局</option></select>
    <input aria-label={`节点 ${index + 1} 标题`} value={node.title ?? ""} placeholder="标题（可选）" onChange={event => onChange({ ...node, title: event.target.value })} />
    <button className="secondary" aria-label={`删除节点 ${index + 1}`} onClick={onRemove}>删除</button>
  </div>;
}

function GraphEdgeEditor({ edge, index, nodes, onChange, onRemove, onJsonError }: Readonly<{
  edge: StoryEdgeV2; index: number; nodes: readonly StoryNodeV1[];
  onChange: (edge: StoryEdgeV2) => void; onRemove: () => void; onJsonError: (key: string, message: string) => void;
}>) {
  return <article className="story-edge-card">
    <div className="story-edge-heading"><strong>边 {index + 1}</strong><button className="secondary" aria-label={`删除边 ${index + 1}`} onClick={onRemove}>删除</button></div>
    <div className="story-edge-grid">
      <label>边 ID<input aria-label={`边 ${index + 1} ID`} value={edge.id} onChange={event => onChange({ ...edge, id: event.target.value })} /></label>
      <label>作用域<input aria-label={`边 ${index + 1} 作用域`} value={edge.scope} onChange={event => onChange({ ...edge, scope: event.target.value })} /></label>
      <label>从节点<select aria-label={`边 ${index + 1} 起点`} value={edge.from} onChange={event => onChange({ ...edge, from: event.target.value })}><option value="">选择起点</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label>
      <label>到节点<select aria-label={`边 ${index + 1} 终点`} value={edge.to} onChange={event => onChange({ ...edge, to: event.target.value })}><option value="">选择终点</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label>
    </div>
    <label>事件依赖（逗号分隔）<input aria-label={`边 ${index + 1} 事件依赖`} value={edge.eventDependencies.join(",")} onChange={event => onChange({ ...edge, eventDependencies: event.target.value.split(",").map(item => item.trim()).filter(Boolean) })} /></label>
    <JsonField label={`边 ${index + 1} 前置条件`} errorKey={`preconditions-${index}`} value={edge.preconditions} onError={onJsonError} onChange={preconditions => onChange({ ...edge, preconditions: preconditions as Readonly<Record<string, unknown>> })} />
    <JsonField label={`边 ${index + 1} 效果`} errorKey={`effects-${index}`} value={edge.effects} onError={onJsonError} onChange={effects => onChange({ ...edge, effects: effects as readonly Readonly<Record<string, unknown>>[] })} />
  </article>;
}

export function StoryEditorPanel({ request, browserPreview }: Readonly<{ request: CreatorRequest; browserPreview: boolean }>) {
  const [projects, setProjects] = useState<readonly StoryProjectRow[]>([]);
  const [document, setDocument] = useState<StoryDocument | null>(null);
  const [savedDocument, setSavedDocument] = useState("");
  const [loading, setLoading] = useState(!browserPreview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [diagnostics, setDiagnostics] = useState<readonly { code: string; path: string; message: string }[]>([]);
  const [jsonErrors, setJsonErrors] = useState<Readonly<Record<string, string>>>({});
  const [hostAnalysis, setHostAnalysis] = useState("");
  const [conditionResult, setConditionResult] = useState<readonly { edgeId: string; to: string }[] | null>(null);
  const [cursor, setCursor] = useState("start");
  const [events, setEvents] = useState("");
  const [flags, setFlags] = useState("{}");
  const [counters, setCounters] = useState("{}");
  const dirty = document !== null && JSON.stringify(document) !== savedDocument;
  const invalid = Object.values(jsonErrors).some(Boolean);

  const loadProjects = async () => {
    if (browserPreview) return;
    setLoading(true); setError("");
    try { setProjects(parseStoryProjects(await request("creator.story.projects.list", { limit: 100 }))); }
    catch (cause) { setError(errorCode(cause, "creator_story_projects_unavailable")); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadProjects(); }, [browserPreview]);
  const adopt = (next: StoryDocument) => {
    setDocument(next); setSavedDocument(JSON.stringify(next)); setDiagnostics([]); setMessage(""); setError(""); setHostAnalysis(""); setConditionResult(null); setJsonErrors({}); setCursor(next.graph.start);
  };
  const open = async (storyId: string) => {
    setBusy(true); setError("");
    try { adopt(parseStoryDocument(await request("creator.story.project.read", { storyId }))); }
    catch (cause) { setError(errorCode(cause, "creator_story_project_unavailable")); }
    finally { setBusy(false); }
  };
  const updateGraph = (graph: StoryDocument["graph"]) => {
    setDocument(current => current ? { ...current, graph } : current); setConditionResult(null);
  };
  const validate = () => {
    if (!document) return false;
    const next = storyDocumentDiagnostics(document); setDiagnostics(next);
    setMessage(next.length === 0 ? "Graph 与 Canon 本地校验通过；保存时 Host 仍会复核预算、身份与 CAS revision。" : `发现 ${next.length} 项诊断，修复后才能保存。`);
    return next.length === 0;
  };
  const save = async () => {
    if (!document || invalid || !validate()) return;
    setBusy(true); setError("");
    try {
      const creating = document.revision === 0;
      await request("creator.story.project.create", storySavePayload(document, creating));
      const saved = parseStoryDocument(await request("creator.story.project.read", { storyId: document.storyId }));
      adopt(saved); setMessage(`已保存到宿主 Registry，revision ${saved.revision}。安装到 City 仍需独立预检与确认。`);
      await loadProjects();
    } catch (cause) { setError(errorCode(cause, "creator_story_save_failed")); }
    finally { setBusy(false); }
  };
  const inspect = async () => {
    if (!document || document.revision === 0) return;
    setBusy(true); setError("");
    try {
      const result = await request<Record<string, unknown>>("creator.story.graph.inspect", { storyId: document.storyId });
      const analysis = result.analysis && typeof result.analysis === "object" ? result.analysis as Record<string, unknown> : {};
      const count = (key: string) => {
        const value = analysis[key];
        return value && typeof value === "object" && typeof (value as { count?: unknown }).count === "number" ? (value as { count: number }).count : "未知";
      };
      setHostAnalysis(`Host revision ${String(result.revision)} · 可达 ${count("reachable")} · 不可达 ${count("unreachable")} · 死胡同 ${count("deadEnds")}；条件与知识不在此 Host 结构中伪装求值。`);
    } catch (cause) { setError(errorCode(cause, "creator_story_graph_inspect_failed")); }
    finally { setBusy(false); }
  };
  const testConditions = () => {
    if (!document) return;
    try {
      const parsedFlags: unknown = JSON.parse(flags); const parsedCounters: unknown = JSON.parse(counters);
      if (!parsedFlags || typeof parsedFlags !== "object" || Array.isArray(parsedFlags)
        || !Object.values(parsedFlags).every(value => typeof value === "boolean")) throw new Error("flags 必须是布尔值对象");
      if (!parsedCounters || typeof parsedCounters !== "object" || Array.isArray(parsedCounters)
        || !Object.values(parsedCounters).every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("counters 必须是数值对象");
      setConditionResult(testStoryConditions(document, { cursor, committedEvents: events.split(",").map(item => item.trim()).filter(Boolean), flags: parsedFlags as Record<string, boolean>, counters: parsedCounters as Record<string, number> }));
      setError("");
    } catch (cause) { setConditionResult(null); setError(cause instanceof Error ? cause.message : "story_condition_input_invalid"); }
  };
  const onJsonError = (key: string, value: string) => setJsonErrors(current => current[key] === value ? current : { ...current, [key]: value });

  return <div className="story-editor-page">
    <aside className="story-registry-sidebar" aria-label="Story 项目列表">
      <div className="home-section-heading"><div><span className="section-title">Story Registry</span><p className="muted">真实宿主项目，不从运行时事件推断。</p></div><button className="secondary" disabled={loading || busy} onClick={() => void loadProjects()}>刷新</button></div>
      <button disabled={busy || dirty} title={dirty ? "先保存当前草稿" : "创建独立 Story"} onClick={() => adopt(newStoryDocument(`story.${crypto.randomUUID()}`))}>新建 Story</button>
      {loading ? <p className="muted">正在读取 Registry…</p> : projects.length === 0 ? <p className="muted">Registry 为空，可新建独立 Story。</p> : <div className="story-registry-list">{projects.map(item => <button key={item.storyId} className={document?.storyId === item.storyId ? "selected" : ""} disabled={busy || (dirty && document?.storyId !== item.storyId)} onClick={() => void open(item.storyId)}><strong>{item.title}</strong><span>{item.storyId} · revision {item.revision}</span></button>)}</div>}
    </aside>
    <section className="story-editor-main" aria-label="Story Editor">
      {browserPreview ? <p className="readiness">浏览器预览只有合成展示，不能创建或修改真实 Story。</p> : !document ? <div className="empty"><p>选择 Registry 项目或新建 Story。Graph、Canon 与条件草稿只在显式保存后写入 Host。</p></div> : <>
        <div className="story-editor-heading"><div><span className="sidebar-kicker">STORY PROJECT</span><h2>{document.title}</h2><code>{document.storyId} · {document.revision === 0 ? "尚未注册" : `revision ${document.revision}`}</code></div><span className="version-pill">{document.revision === 0 ? "未注册草稿" : dirty ? "未保存草稿" : "与 Host 一致"}</span></div>
        <div className="story-meta-grid"><label>标题<input aria-label="Story 标题" value={document.title} onChange={event => setDocument({ ...document, title: event.target.value })} /></label><label>内容版本<input aria-label="Story 内容版本" value={document.storyVersion} onChange={event => setDocument({ ...document, storyVersion: event.target.value })} /></label></div>
        <section className="story-editor-section"><div className="home-section-heading"><div><span className="section-title">Story Graph</span><p className="muted">节点、边、条件和效果都是项目内容；不会直接修改玩家 Run。</p></div><button className="secondary" onClick={() => updateGraph({ ...document.graph, nodes: [...document.graph.nodes, { id: `beat-${document.graph.nodes.length + 1}`, kind: "beat", title: "新剧情" }] })}>添加节点</button></div>
          <label>入口节点 ID<input aria-label="Graph 入口节点" value={document.graph.start} onChange={event => updateGraph({ ...document.graph, start: event.target.value })} /></label>
          <div className="story-node-list">{document.graph.nodes.map((node, index) => <GraphNodeEditor key={index} node={node} index={index} onChange={next => updateGraph({ ...document.graph, nodes: document.graph.nodes.map((item, at) => at === index ? next : item) })} onRemove={() => updateGraph({ ...document.graph, nodes: document.graph.nodes.filter((_, at) => at !== index) })} />)}</div>
          <div className="story-edge-heading"><strong>剧情边</strong><button className="secondary" disabled={document.graph.nodes.length < 2} onClick={() => updateGraph({ ...document.graph, edges: [...document.graph.edges, { id: `edge-${document.graph.edges.length + 1}`, from: document.graph.nodes[0].id, to: document.graph.nodes[1].id, preconditions: {}, effects: [], eventDependencies: [], scope: "story" }] })}>添加边</button></div>
          {document.graph.edges.map((edge, index) => <GraphEdgeEditor key={index} edge={edge} index={index} nodes={document.graph.nodes} onChange={next => updateGraph({ ...document.graph, edges: document.graph.edges.map((item, at) => at === index ? next : item) })} onRemove={() => updateGraph({ ...document.graph, edges: document.graph.edges.filter((_, at) => at !== index) })} onJsonError={onJsonError} />)}
        </section>
        <section className="story-editor-section"><span className="section-title">Character Canon</span><p className="muted">characters 数组使用 CharacterCanonV1；storyId 必须与本项目一致，成长事件引用会按 Graph 声明检查。</p>
          <JsonField label="Canon JSON" errorKey="canon" value={document.canon} onError={onJsonError} onChange={canon => { if (canon && typeof canon === "object" && !Array.isArray(canon)) setDocument({ ...document, canon: canon as Record<string, unknown> }); }} />
        </section>
        <section className="story-editor-section"><span className="section-title">条件本地测试</span><p className="muted">只运行 Narrative SDK 的显式本地快照，不是 City Run、Host 证据或玩家进度。</p>
          <div className="story-condition-grid"><label>当前游标<input aria-label="条件测试游标" value={cursor} onChange={event => setCursor(event.target.value)} /></label><label>已提交事件（逗号分隔）<input aria-label="条件测试事件" value={events} onChange={event => setEvents(event.target.value)} /></label><label>Flags JSON<input aria-label="条件测试 Flags" value={flags} onChange={event => setFlags(event.target.value)} /></label><label>Counters JSON<input aria-label="条件测试 Counters" value={counters} onChange={event => setCounters(event.target.value)} /></label></div>
          <div className="actions"><button className="secondary" onClick={testConditions}>测试当前可选边</button></div>{conditionResult && <p role="status">{conditionResult.length === 0 ? "当前快照没有满足条件的出边。" : `可选边：${conditionResult.map(item => `${item.edgeId} → ${item.to}`).join("；")}`}</p>}
        </section>
        {diagnostics.length > 0 && <ul className="story-diagnostics" aria-label="Story 校验诊断">{diagnostics.map((item, index) => <li key={`${item.path}:${item.code}:${index}`}><code>{item.code}</code> · {item.path}<br />{item.message}</li>)}</ul>}
        {hostAnalysis && <p className="readiness" role="status">{hostAnalysis}</p>}
        {message && <p className="status-banner" role="status">{message}</p>}{error && <p className="library-error" role="alert">{error}</p>}
        <div className="actions story-save-actions"><button className="secondary" disabled={busy || document.revision === 0 || dirty} onClick={() => void inspect()}>读取 Host 图诊断</button><button className="secondary" disabled={busy || invalid} onClick={validate}>校验草稿</button><button disabled={busy || invalid || !dirty || !document.title.trim() || !document.storyVersion.trim()} onClick={() => void save()}>{document.revision === 0 ? "创建并注册 Story" : "保存新 revision"}</button></div>
      </>}
    </section>
  </div>;
}
