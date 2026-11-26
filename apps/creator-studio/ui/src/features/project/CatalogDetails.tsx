import type { RefObject } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import type { CityRow, LayoutRow } from "../../contracts/creatorStudio";
import { catalogLabels, type CatalogEntry } from "./projectCatalogModel";
import type { StoryProjectRow } from "../library/cityGameLibraryModel";
import { useCatalogContent, useCityGameInstallations } from "./useProjectCatalogData";
import cityCover from "./assets/city-cover.webp";
import desertCover from "./assets/desert-cover.webp";
import gameCover from "./assets/game-cover.webp";
import collectionCover from "./assets/collection-cover.webp";
import storyCover from "./assets/story-cover.webp";

const covers = { city: cityCover, game: gameCover, story: storyCover };
const installLabels = { installed: "已安装", disabled: "已停用", "update-available": "可更新", unknown: "状态未知" } as const;

export const catalogDate = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });

export function catalogCover(entry: CatalogEntry) {
  if (entry.kind === "game" && entry.templateId === "collect-one") return collectionCover;
  return entry.kind === "city" && entry.biome === "arid" ? desertCover : covers[entry.kind];
}

export function CatalogDetails({ entry, request, cities, layouts, storyProjects, browserPreview, actionLabel, busy, onOpen, onConfigureGame, onRefresh, onOpenGamePreview, detailRef }: {
  entry: CatalogEntry | undefined;
  request: CreatorRequest;
  cities: readonly CityRow[];
  layouts: readonly LayoutRow[];
  storyProjects: readonly StoryProjectRow[];
  browserPreview: boolean;
  actionLabel: string;
  busy: boolean;
  onOpen: () => void;
  onConfigureGame: (projectId: string) => void;
  onRefresh: () => void;
  onOpenGamePreview: (buildId: string, cityId: string) => void;
  detailRef: RefObject<HTMLElement | null>;
}) {
  const city = entry?.kind === "city" ? entry : null;
  const content = useCatalogContent(request, entry);
  const installations = useCityGameInstallations(request, city?.id ?? null, city?.revision ?? null);
  const layout = city && layouts.find(row => row.cityId === city.id && row.cityRevision === city.revision);
  const facts = content.current?.content;
  const gameCity = facts?.kind === "game" ? cities.find(row => row.cityId === facts.cityId) : undefined;
  const installed = installations.current?.rows;
  const installedCount = installations.current?.installedCount;
  const installedStories = installations.current?.stories;
  const needsMount = facts?.kind === "game" && facts.hasLayout && facts.mounts === 0;
  const next = city ? "在只读视口查看城市和场景。"
    : facts?.kind === "game" && facts.mounts === 0 ? "进入编辑器配置玩法场地，保存后可继续准备试玩。"
      : facts?.kind === "story" && !browserPreview ? "进入编辑器查看剧情节点和角色设定。" : undefined;

  return <aside ref={detailRef} tabIndex={-1} id="catalog-selected-details"
    className={city ? "studio-catalog-detail is-city" : "studio-catalog-detail"} aria-label="所选详情">
    {entry ? <>
      <h2 className="catalog-detail-label">项目详情</h2>
      <img className="catalog-detail-art" src={catalogCover(entry)} alt="" width="840" height="630" />
      <div className="catalog-detail-heading">
        <h3>{entry.name}</h3>
        <p>{catalogLabels[entry.kind]}{city ? " · 只读" : ""}{entry.version ? ` · 剧情版本 ${entry.version}` : ""}</p>
        {entry.kind === "game" && entry.summary && <p>{entry.summary}</p>}
        {facts?.kind === "story" && facts.introduction && <p>{facts.introduction}</p>}
      </div>
      <section className="catalog-detail-section" aria-label={city ? "世界概览" : entry.kind === "game" ? "玩法概览" : "剧情概览"}>
        <h4>{city ? "世界概览" : entry.kind === "game" ? "玩法概览" : "剧情概览"}</h4>
        <dl className="catalog-facts">
          {city?.summary && <div><dt>地貌</dt><dd>{city.summary}</dd></div>}
          {layout && <div><dt>布局锚点</dt><dd>{layout.anchorCount} 个</dd></div>}
          {entry.templateLabel && <div><dt>玩法模板</dt><dd>{entry.templateLabel}</dd></div>}
          {facts?.kind === "game" && <>
            {facts.cityId && <div><dt>关联城市</dt><dd>{gameCity?.name ?? "已关联 City"}</dd></div>}
            {facts.anchorCount !== undefined && <div><dt>场景锚点</dt><dd>{facts.anchorCount} 个</dd></div>}
            {facts.mounts !== undefined && <div><dt>玩法场地</dt><dd>{facts.mounts === 0 ? "待配置" : `已绑定 ${facts.mounts} 处`}</dd></div>}
          </>}
          {facts?.kind === "story" && <>
            {facts.opening && <div><dt>开场</dt><dd>{facts.opening}</dd></div>}
            <div><dt>剧情结构</dt><dd>{facts.scenes} 个节点{facts.links !== undefined ? ` · ${facts.links} 条连接` : ""}</dd></div>
            {facts.characters !== undefined && <div><dt>角色设定</dt><dd>{facts.characters} 个</dd></div>}
          </>}
          {!!entry.updatedAtMs && <div><dt>最近修改</dt><dd>{catalogDate.format(entry.updatedAtMs)}</dd></div>}
          {city && <div><dt>城市修订</dt><dd>{entry.revision}</dd></div>}
        </dl>
        {!city && (content.current === null ? <p role="status">正在读取内容概况…</p>
          : !facts && <p role="alert">暂时无法读取此版本的内容。 <button onClick={() => { onRefresh(); content.retry(); }}>重试</button></p>)}
      </section>
      {city && <section className="catalog-detail-section catalog-installations" aria-label="游戏安装记录">
        <div className="catalog-section-heading"><h4>游戏安装记录</h4>{typeof installedCount === "number" && <span>{installedCount} 个已安装</span>}</div>
        {!installations.current ? <p role="status">正在读取安装记录…</p> : !installed
          ? <p role="alert">安装记录暂不可用。 <button onClick={installations.retry}>重试</button></p>
          : installed.length === 0 ? <p>暂无游戏安装记录。</p>
          : <ul>{installed.map(row => <li key={row.installationId}>
            <div><strong>{row.displayName ?? row.gameId}</strong>
              <small>{[row.gameVersion ? `版本 ${row.gameVersion}` : null, installLabels[row.status]].filter(Boolean).join(" · ")}</small>
            </div>
            {!browserPreview && (row.status === "installed" || row.status === "update-available") && <button type="button" className="catalog-secondary"
              disabled={busy} onClick={() => onOpenGamePreview(row.buildId, city.id)}>准备试玩</button>}
          </li>)}</ul>}
      </section>}
      {city && installations.current && <section className="catalog-detail-section catalog-installations" aria-label="已安装剧情">
        <h4>已安装剧情</h4>
        {!installedStories ? <p role="alert">剧情安装记录暂不可用。 <button onClick={installations.retry}>重试</button></p>
          : installedStories.length === 0 ? <p>暂无已安装剧情。</p>
          : <ul>{installedStories.map(row => {
            const story = storyProjects.find(project => project.storyId === row.storyId && project.contentDigest === row.contentDigest && project.storyVersion === row.storyVersion);
            return <li key={row.installationId}><strong>{story?.title ?? row.storyId}</strong><small>版本 {row.storyVersion}</small></li>;
          })}</ul>}
      </section>}
      <section className="catalog-detail-section catalog-next" aria-label="下一步">
        <h4>下一步</h4>
        {next && <p>{next}</p>}
        <button className="catalog-primary" disabled={busy}
          onClick={() => needsMount ? onConfigureGame(entry.id) : onOpen()}>{needsMount ? "配置场地" : actionLabel}</button>
      </section>
    </> : <h3>未选择</h3>}
    {browserPreview && <p>浏览器演示使用合成数据。</p>}
  </aside>;
}
