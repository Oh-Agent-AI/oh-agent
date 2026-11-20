import { useCallback, useRef, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";

export type AgentActivityItem = { method: string; label: string; summary: string; ok: boolean; revision?: number; at: number };

export function useAgentActivity(request: CreatorRequest) {
  // Agent 活动卡片（设计 §7.3）：经活动 Studio 转发的 MCP 预览/提交/发布/试玩请求，
  // 新在前、有界保留；UI 自己的操作直连宿主、不出现在这里。
  const [agentActivity, setAgentActivity] = useState<readonly AgentActivityItem[]>([]);
  // 活动卡持久化（T3 对照 §6.2-O4，NotificationMailbox 语义：重要通知不丢）：
  // 卡片写入插件私有 state（creator-agent-activity:v1，revision CAS），重启后重放。
  // 失败的临时活动可丢；成功的 Agent 提交历史是必须存活的最低限度。
  const agentActivityRef = useRef<readonly AgentActivityItem[]>([]);
  const agentActivityStateRevisionRef = useRef(0);
  const persistAgentActivity = useCallback(() => {
    const value = { items: agentActivityRef.current };
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await request("plugin.state.write", { key: "creator-agent-activity:v1", revision: agentActivityStateRevisionRef.current, value });
          agentActivityStateRevisionRef.current += 1;
          return;
        } catch {
          // CAS 冲突或瞬时失败：重读权威副本合并后重试一次；再失败静默（卡片是尽力而为的 UX）。
          try {
            const state = await request<{ revision: number; value: { items?: readonly AgentActivityItem[] } }>("plugin.state.read", { key: "creator-agent-activity:v1" });
            agentActivityStateRevisionRef.current = state.revision;
            agentActivityRef.current = state.value.items ?? agentActivityRef.current;
          } catch { return; }
        }
      }
    })();
  }, [request]);
  const recordAgentActivity = useCallback((item: AgentActivityItem) => {
    const list = [item, ...agentActivityRef.current].slice(0, 6);
    agentActivityRef.current = list;
    setAgentActivity(list);
    persistAgentActivity();
  }, [persistAgentActivity]);
  const restoreAgentActivity = useCallback(async () => {
    try {
      const state = await request<{ revision: number; value: { items?: AgentActivityItem[] } }>("plugin.state.read", { key: "creator-agent-activity:v1" });
      agentActivityStateRevisionRef.current = state.revision;
      const items = state.value.items ?? [];
      agentActivityRef.current = items;
      setAgentActivity(items);
    } catch { /* 空态即可：state 缺失/损坏不阻塞 Studio 就绪 */ }
  }, [request]);
  return { agentActivity, recordAgentActivity, restoreAgentActivity };
}
