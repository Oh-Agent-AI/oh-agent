import { useEffect, useLayoutEffect, useRef } from "react";
import { Vector3, type Group } from "three";
import type { CityEngine } from "../engine/CityEngine";
import { terrainSurfaceHeight } from "../engine/surface/terrainSampling";
import { createAssaultCityGround } from "./assaultCityGround";
import { createCityMonster, disposeCityMonster } from "./cityMonster";
import type { MonsterEncounter } from "./mecha/monsterEncounters";

const LABELS = {
  zh: { flat: "平地", shore: "靠岸", ridge: "翻山", alley: "巷战" },
  en: { flat: "Flat", shore: "Shore", ridge: "Ridge", alley: "Alley" },
} as const;

export function MonsterWorldMarkers({ engine, encounters, language, onEnter }: {
  engine: CityEngine | null;
  encounters: MonsterEncounter[];
  language: string;
  onEnter: (encounter: MonsterEncounter) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const models = useRef(new Map<MonsterEncounter, Group>());
  const enter = useRef(onEnter); enter.current = onEnter;
  useLayoutEffect(() => {
    if (!engine || !encounters.length) return;
    const layout = engine.currentLayout;
    if (!layout) return;
    const source = engine.captureMechaGroundSource();
    let ground: (x: number, z: number) => number = (x, z) => terrainSurfaceHeight(layout, x, z);
    if (source && source.source.layout === layout) {
      try { ground = createAssaultCityGround(layout, source.source.ground, source.isCurrent); }
      catch (error) { console.warn("monster road surface unavailable", error); }
    }
    const created: Group[] = [];
    for (const encounter of encounters) {
      if (engine.currentLayout !== encounter.layout || engine.currentModel !== encounter.model) continue;
      try {
        const boss = createCityMonster(encounter, ground);
        models.current.set(encounter, boss);
        created.push(boss);
        engine.addEncounterTarget(boss, () => enter.current(encounter));
      } catch (error) { console.warn("monster placement unavailable", encounter.shape, error); }
    }
    return () => {
      for (const boss of created) { engine.removeEncounterTarget(boss); disposeCityMonster(boss); }
      models.current.clear();
    };
  }, [engine, encounters]);
  useEffect(() => {
    if (!engine) return;
    let frame = 0;
    const point = new Vector3();
    const draw = () => {
      const camera = engine.renderCamera;
      const canvas = engine.domCanvas as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const parent = canvas.parentElement?.getBoundingClientRect();
      for (const [index, encounter] of encounters.entries()) {
        const button = buttons.current[index];
        if (!button || !parent) continue;
        const boss = models.current.get(encounter);
        const current = engine.currentLayout === encounter.layout && engine.currentModel === encounter.model;
        if (boss) boss.visible = current;
        const at = encounter.at;
        const y = boss?.position.y ?? 0;
        point.set(at.x, y + 20, at.z).project(camera);
        const visible = Boolean(boss) && current && point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
        button.style.visibility = visible ? "visible" : "hidden";
        if (visible) {
          button.style.left = `${rect.left - parent.left + (point.x + 1) * rect.width / 2}px`;
          button.style.top = `${rect.top - parent.top + (1 - point.y) * rect.height / 2}px`;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [engine, encounters]);
  const labels = language === "en" ? LABELS.en : LABELS.zh;
  return <div className="city-monster-markers">{encounters.map((encounter, index) => {
    const title = language === "en" ? `${labels[encounter.shape]} monster encounter — start tactics` : `${labels[encounter.shape]}怪兽遭遇点，进入机甲战棋`;
    return <button key={encounter.shape} ref={(node) => { buttons.current[index] = node; }} type="button" className="city-monster-marker" title={title} aria-label={title} onClick={() => onEnter(encounter)}><span aria-hidden="true">◆</span></button>;
  })}</div>;
}
