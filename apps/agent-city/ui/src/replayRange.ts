/** Query coverage is not replay coverage. Only loaded sessions can grow. */
export function replayStartMs(sessions: ReadonlyArray<{ first_event_at: string }>, from: number, to: number): number {
  const starts = sessions.map((session) => Date.parse(session.first_event_at)).filter((at) => Number.isFinite(at) && at <= to);
  if (!starts.length) return from;
  // 回放从第一栋会话楼开始生成的那一刻起，而不是那一天的 0 点：默认「每秒 1 小时」下，取整到 0 点最多要对着
  // 一座空城等 24 秒才出现第一栋楼。
  return Math.max(from, Math.min(to, Math.min(...starts)));
}
