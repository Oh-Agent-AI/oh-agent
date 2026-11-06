import { useEffect, useState, type ComponentProps } from "react";
import type { CityModuleV3 } from "@agent-vitals/app-sdk";
import { readCityModule, type CityProjectionV1 } from "./data/provider";
import { cityText } from "./i18n";
import { CityPanel } from "./CityPanel";
import { CITY_DATA_PLACES, type CityDataPlaceId } from "./cityDataPlaces";

type Props = { harness?: string | null; id: CityDataPlaceId; projection: CityProjectionV1; language: string; onClose(): void; onLocate(id: string): boolean;
  back?: ComponentProps<typeof CityPanel>["back"] };
const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) : [];

export function CityDataFacility({ id, projection, language, onClose, onLocate, harness, back }: Props) {
  const en = language === "en";
  const place = CITY_DATA_PLACES.find((item) => item.id === id)!;
  const [loaded, setLoaded] = useState<{ module: CityModuleV3; from: string; to: string; generated: string | null; timezone: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [missing, setMissing] = useState(false);
  const [visibleDays, setVisibleDays] = useState(30);
  useEffect(() => {
    setLoaded(null); setMissing(false); setVisibleDays(30);
    if (id === "overview" || id === "activity") { setPending(false); return; }
    const request = new AbortController(); setPending(true);
    void readCityModule(projection, id, request.signal, retry > 0, harness ?? undefined).then((response) => {
      if (request.signal.aborted) return;
      const module = response.result as CityModuleV3 | undefined;
      if (!module || !["ready", "empty", "unsupported", "unavailable", "stale"].includes(module.state)) throw new Error("city_module_invalid");
      setLoaded({ module, from: response.window.from, to: response.window.to, generated: response.generated_at,
        timezone: "timezone" in response.window ? String(response.window.timezone) : "UTC" });
    }).catch(() => {
      if (!request.signal.aborted) setLoaded({ module: { state: "unavailable", supported: true, reason: "module_unavailable" },
        from: projection.window.from, to: projection.window.to, generated: projection.generated_at, timezone: "UTC" });
    }).finally(() => { if (!request.signal.aborted) setPending(false); });
    return () => request.abort();
  }, [id, projection, retry, harness]);
  const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value.toLocaleString(en ? "en-US" : "zh-CN") : "—";
  const summary = projection.summary;
  const stats = summary?.tokens;
  const current = rows(loaded?.module.data?.current_backlog);
  const added = rows(loaded?.module.data?.window_new);
  const renderFindings = (items: Array<Record<string, unknown>>) => items.length ? <ul className="city-facility-list">{items.map((row, index) => <li key={index}>
    <strong>{projection.harnesses.find((h) => h.id === row.harness)?.display_name ?? String(row.harness ?? "")}</strong>
    <span>{String(row.severity ?? "")} · {String(row.category ?? cityText("汇总", language))}</span><b>{number(row.count)}</b>
  </li>)}</ul> : <p>{cityText("此分类没有已记录问题。", language)}</p>;
  return <CityPanel className="city-data-facility" focusOnOpen busy={pending} onClose={onClose} back={back} closeLabel={cityText("关闭数据设施", language)}
    eyebrow={cityText("公共服务 · 数据窗口", language)}
    context={harness ? projection.harnesses.find((h) => h.id === harness)?.display_name ?? harness : cityText("全城", language)}
    title={en ? place.englishTitle : place.title}>
    <p>{en ? place.englishDescription : place.description}</p>
    <p className="city-context-note">{projection.source === "fixture" ? cityText("合成演示数据", language) : cityText("本机只读数据", language)} · {loaded?.timezone ?? projection.activity?.timezone ?? "UTC"}</p>
    <p className="city-facility-window">{loaded?.from ?? projection.window.from}<br />{loaded?.to ?? projection.window.to}</p>
    {id === "overview" && <>
      <dl><dt>{cityText("窗口内会话", language)}</dt><dd>{number(summary?.session_count ?? projection.coverage.total)}</dd>
        <dt>{cityText("已载入建筑", language)}</dt><dd>{number(projection.coverage.returned)} / {number(projection.coverage.total)}</dd>
        <dt>{cityText("usage 事件行", language)}</dt><dd>{number(summary?.usage_event_count)}</dd>
        <dt>{cityText("全窗口 token", language)}</dt><dd>{number(stats?.total)}</dd>
        <dt>{cityText("未缓存输入", language)}</dt><dd>{number(stats?.uncached_input)}</dd>
        <dt>{cityText("缓存读取", language)}</dt><dd>{number(stats?.cache_read)}</dd>
        <dt>{cityText("缓存写入", language)}</dt><dd>{number(stats?.cache_write)}</dd>
        <dt>{cityText("输出 token", language)}</dt><dd>{number(stats?.output)}</dd></dl>
      {projection.coverage.time_classification && <><h3>{cityText("时间覆盖（全库）", language)}</h3><dl>
        <dt>{cityText("仅有无时间记录", language)}</dt><dd>{number(projection.coverage.time_classification.unknown_time_only)}</dd>
        <dt>{cityText("混合时间记录", language)}</dt><dd>{number(projection.coverage.time_classification.mixed_time)}</dd>
        <dt>{cityText("没有 usage 记录", language)}</dt><dd>{number(projection.coverage.time_classification.excluded_no_usage)}</dd></dl>
        <p>{cityText("时间未知的用量不能猜测归属当前窗口。", language)}</p></>}
      <p>{cityText("全窗统计包含所有匹配会话；建筑与回放只包含已载入部分。usage 行数不等于工具调用次数。", language)}</p>
    </>}
    {id === "activity" && <>
      <h3>{cityText("已观测模型", language)}</h3>
      {projection.models?.length ? <ul className="city-facility-models">{projection.models.map((model) => <li key={model}>{model}</li>)}</ul>
        : <p>{cityText("当前投影没有可用模型标识；不代表没有模型用量。", language)}</p>}
      {projection.model_coverage && <p>{cityText("未知模型 usage 行：", language)}{number(projection.model_coverage.unknown_model_usage_events)}</p>}
      <h3>{cityText("每日活动", language)}</h3>
      {projection.activity ? <>
        {projection.activity.busiest_day && <p>{cityText("最忙的一天：", language)}{projection.activity.busiest_day.date} · {number(projection.activity.busiest_day.session_count)} {cityText("个活跃会话", language)}</p>}
        <p>{cityText("依次按活跃会话、token、最近日期选取最忙日。", language)}</p>
        <div className="city-facility-table-wrap"><table><thead><tr><th>{cityText("日期", language)}</th><th>{cityText("活跃会话", language)}</th><th>{cityText("usage 行", language)}</th><th>Token</th></tr></thead>
          <tbody>{[...projection.activity.days].reverse().slice(0,visibleDays).map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td>{number(day.session_count)}</td><td>{number(day.event_count)}</td><td>{number(day.tokens)}</td></tr>)}</tbody></table></div>
        {projection.activity.days.length > visibleDays && <button onClick={() => setVisibleDays((value) => value + 30)}>{cityText("再显示 30 个活动日期", language)}</button>}
      </> : <p>{cityText("当前投影尚未提供每日活动。", language)}</p>}
    </>}
    {pending && <p role="status">{cityText("正在读取设施数据…", language)}</p>}
    {loaded && <>
      {loaded.module.state === "unsupported" && <div className="city-facility-status"><h3>{cityText("数据尚未接入", language)}</h3>
        <p>{cityText("这个模块尚未注册 City 数据投影。不会把安装数量、token 或缺失记录显示成使用次数 0。", language)}</p></div>}
      {(loaded.module.state === "unavailable" || loaded.module.state === "stale") && <p role="status">{cityText("数据暂不可用，或城市快照已经更新。", language)}</p>}
      {id === "workflow" && ["ready", "empty"].includes(loaded.module.state) && <>
        <h3>{en ? "Observed workflow events" : "已观测工作流事件"}</h3>
        <p>{en ? "Recorded events only. Starts and finishes are not paired; these counts do not measure success rate or running tasks." : "仅统计已记录事件。开始与结束未逐次配对，不能据此计算成功率或运行中任务数。"}</p>
        <ul className="city-facility-list city-skill-list">{rows(loaded.module.data?.events).map((row, index) => <li key={index}>
          <strong>{String(row.event_type)} · {projection.harnesses.find((h) => h.id === row.harness)?.display_name ?? String(row.harness)}</strong>
          <p>{en ? "Events / sessions / failed events" : "事件 / 涉及会话 / 失败事件"}: {number(row.events)} / {number(row.sessions)} / {number(row.failed_events)}</p>
        </li>)}</ul>
        {!rows(loaded.module.data?.events).length && <p>{en ? "No recorded workflow events in this scope; source coverage may be incomplete." : "当前范围没有已记录的工作流事件；数据源覆盖可能不完整。"}</p>}
        {loaded.module.data?.truncated === true && <p>{en ? "Limited to 200 environment/event combinations." : "最多显示 200 个执行环境与事件类型组合。"}</p>}
      </>}
      {id === "skills" && ["ready", "empty"].includes(loaded.module.state) && <>
        <h3>{cityText("已观测技能活动", language)}</h3>
        <p>{cityText("仅统计窗口内有记录的技能调用；不是已安装技能清单，缺少记录不代表没有使用。", language)}</p>
        {rows(loaded.module.data?.skills).length ? <ul className="city-facility-list city-skill-list">{rows(loaded.module.data?.skills).map((row, index) => <li key={index}>
          <strong>{String(row.skill)} · {projection.harnesses.find((h) => h.id === row.harness)?.display_name ?? String(row.harness)}</strong>
          <dl><dt>{cityText("调用记录", language)}</dt><dd>{number(row.invocations)}</dd>
            <dt>{cityText("涉及会话", language)}</dt><dd>{number(row.sessions)}</dd>
            <dt>{cityText("成功结束事件", language)}</dt><dd>{number(row.succeeded_events)}</dd>
            <dt>{cityText("失败结束事件", language)}</dt><dd>{number(row.failed_events)}</dd>
            <dt>{cityText("全部结束事件", language)}</dt><dd>{number(row.finished_events)}</dd>
            <dt>{cityText("最近调用", language)}</dt><dd>{typeof row.last_invoked_at_ms === "number" ? new Date(row.last_invoked_at_ms).toLocaleString(en ? "en-US" : "zh-CN", { timeZone: loaded.timezone }) : "—"}</dd></dl>
        </li>)}</ul> : <p>{cityText("当前范围没有已记录的技能事件；数据源可能尚未提供这类证据。", language)}</p>}
        <p>{cityText("结束事件与调用未逐次配对，不能据此计算成功率；跨窗口结束也可能缺少本窗口调用。", language)}</p>
        {loaded.module.data?.truncated === true && <p>{cityText("仅显示调用记录最多的前 200 个技能与执行环境组合。", language)}</p>}
      </>}
      {id === "findings" && ["ready", "empty"].includes(loaded.module.state) && <>
        <h3>{cityText("当前未关闭积压", language)}</h3>{renderFindings(current)}
        <h3>{cityText("窗口内新增", language)}</h3>{renderFindings(added)}
        {rows(loaded.module.data?.capabilities).some((row) => {
          const capabilities = row.capabilities as { findings?: { available?: boolean } } | undefined;
          return capabilities?.findings?.available === false;
        }) && <p>{cityText("暂未提供 Findings 的执行环境：", language)}{rows(loaded.module.data?.capabilities).filter((row) => {
          const capabilities = row.capabilities as { findings?: { available?: boolean } } | undefined;
          return capabilities?.findings?.available === false;
        }).map((row) => String(row.display_name ?? row.id)).join(en ? ", " : "、")}</p>}
        <p>{cityText("积压按当前 open/later 状态统计；新增按首次记录时间统计，可能已关闭。模块覆盖以执行环境能力为准。", language)}</p>
      </>}
      {loaded.generated && <p className="city-context-note">{cityText("读取时间：", language)}{loaded.generated}</p>}
      <button onClick={() => setRetry((value) => value + 1)}>{cityText("重新读取", language)}</button>
    </>}
    <button onClick={() => setMissing(!onLocate(harness ? `district-service:${harness}:${id === "findings" ? "hospital" : id === "skills" ? "school" : "workflow"}` : place.catalogId))}>{cityText("定位场景建筑", language)}</button>
    {missing && <p role="status">{cityText("当前规模尚未生成该设施，仍可在这里查看数据。", language)}</p>}
    <p className="city-context-note">{cityText("这里不会发放游戏收入、关闭真实问题或执行技能。", language)}</p>
    <button onClick={onClose}>{cityText("返回城市", language)}</button>
  </CityPanel>;
}
