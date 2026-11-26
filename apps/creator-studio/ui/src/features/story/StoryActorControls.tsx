import { useEffect, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import { errorCode } from "../../adapters/creatorHostUtils";

type Choice = Readonly<{ id: string; name: string }>;
type ActorStatus = Readonly<{ state: "idle" | "failed" | "connecting" | "ready" | "stopping"; code?: string; characterId?: string | null; agentId?: string }>;

const labels = {
  idle: "未连接",
  connecting: "正在连接 Actor…",
  ready: "Actor 已连接，可以在 City 发送对白。",
  stopping: "正在关闭 Actor…",
  failed: "Actor 连接或回复失败。",
} as const;

export function StoryActorControls({ request, storyRunId, characters }: Readonly<{
  request: CreatorRequest; storyRunId: string; characters: readonly Choice[];
}>) {
  const [agents, setAgents] = useState<readonly Choice[]>([]);
  const [agentId, setAgentId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [status, setStatus] = useState<ActorStatus | null>(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedCharacter = status?.characterId || characterId || characters[0]?.id || "";
  const locked = status === null || ["connecting", "ready", "stopping"].includes(status.state);

  useEffect(() => {
    let active = true;
    void request<{ agents: readonly Choice[] }>("creator.story.actor.options", {})
      .then(result => { if (active) setAgents(result.agents); })
      .catch(cause => { if (active) setError(errorCode(cause, "acp_unavailable")); });
    return () => { active = false; };
  }, [request]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await request<ActorStatus>("creator.story.actor.status", { storyRunId });
        if (active) {
          setStatus(result);
          setStatusError(false);
        }
      } catch {
        if (active) setStatusError(true);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1_000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [request, storyRunId]);

  async function setConnection(start: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = start
        ? await request<ActorStatus>("creator.story.actor.start", { storyRunId, characterId: selectedCharacter, agentId })
        : await request<ActorStatus>("creator.story.actor.stop", { storyRunId });
      setStatus(result);
    } catch (cause) {
      setError(errorCode(cause, "acp_failed"));
    } finally {
      setBusy(false);
    }
  }

  return <fieldset className="story-actor-controls" disabled={busy}>
    <legend>角色扮演</legend>
    <label>角色<select disabled={locked || !!status?.characterId} value={selectedCharacter} onChange={event => setCharacterId(event.target.value)}>
      {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
    </select></label>
    <label>扮演角色的 Agent<select disabled={locked} value={locked ? status?.agentId ?? agentId : agentId} onChange={event => setAgentId(event.target.value)}>
      <option value="">选择已安装的 Agent</option>
      {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
    </select></label>
    <p className="muted">启动后，本回合的玩家对白和角色设定会交给所选 ACP Agent。</p>
    <div className="actions">
      {!locked && <button type="button" onClick={() => void setConnection(true)} disabled={!agentId || !selectedCharacter}>连接角色 Agent</button>}
      {locked && status && status.state !== "stopping" && <button type="button" className="secondary" onClick={() => void setConnection(false)}>断开角色 Agent</button>}
    </div>
    {status && <p role="status">{labels[status.state]} {status.code && <code>{status.code}</code>}</p>}
    {statusError && <p role="status">暂时无法读取 Actor 状态，正在重试。</p>}
    {error && <p role="alert">无法操作 Actor（{error}）。</p>}
  </fieldset>;
}
