import { useMemo } from "react";
import { cityText, useCityLanguage } from "./i18n";
import {
  DEFAULT_KIND_FILTER, actorLabel, envelopeAssetRef, feedDetail, isWriteKind, visibleFeed,
  type SquadEnvelope, type SquadKind, KILL_FEED_MS,
} from "./engine/squadEvents";

const KIND_LABEL: Record<SquadKind, string> = {
  chat: "聊天",
  claim: "占用",
  release: "释放",
  preview: "预览",
  reject: "拒绝",
  set: "写入",
  reset: "重置",
  observe: "观察",
};

type Props = {
  items: SquadEnvelope[];
  onFocus(assetRef: string): void;
  nowMs: number;
  open: boolean;
  onOpen(open: boolean): void;
};

export function SquadFeed({ items, onFocus, nowMs, open, onOpen }: Props) {
  const language = useCityLanguage();
  const visible = useMemo(() => visibleFeed(items), [items]);
  const kill = useMemo(
    () => items.filter((item) => isWriteKind(item.kind) && DEFAULT_KIND_FILTER[item.kind] && (nowMs - item.ts * 1000) < KILL_FEED_MS).slice(0, 4),
    [items, nowMs],
  );
  return (
    <>
      {kill.length > 0 && <ol className="city-squad-kill" aria-label={cityText("小队快讯", language)}>
        {kill.map((item) => (
          <li key={item.id} data-kind={item.kind}>
            <strong>{cityText(actorLabel(item), language)}</strong>
            <span>{cityText(KIND_LABEL[item.kind], language)}</span>
            {envelopeAssetRef(item) && <button type="button" onClick={() => onFocus(envelopeAssetRef(item)!)}>{cityText("定位", language)}</button>}
          </li>
        ))}
      </ol>}
      <aside className={open ? "city-squad-feed is-open" : "city-squad-feed"} aria-label={cityText("小队频道", language)}>
        <button type="button" className="city-squad-toggle" aria-expanded={open} onClick={() => onOpen(!open)}>
          {cityText(open ? "收起小队" : "小队频道", language)}
        </button>
        {open && <>
          <p className="city-squad-hint">{cityText("施工记录标出这次 MCP 连接的客户端，例如 Claude Code 或 Codex。对方没报名字时显示「别的」。", language)}</p>
          {visible.length === 0 ? <p>{cityText("还没有施工事件。", language)}</p> : <ol>
            {visible.map((item) => {
              const asset = envelopeAssetRef(item);
              return <li key={item.id} data-kind={item.kind}>
                <span className="city-squad-meta">{cityText(actorLabel(item), language)} · {cityText(KIND_LABEL[item.kind], language)}</span>
                <span className="city-squad-body">{feedDetail(item, language)}</span>
                {asset && <button type="button" onClick={() => onFocus(asset)}>{cityText("定位建筑", language)}</button>}
              </li>;
            })}
          </ol>}
        </>}
      </aside>
    </>
  );
}
