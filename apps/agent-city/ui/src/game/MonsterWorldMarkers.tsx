import { useEffect, useRef } from "react";
import { Vector3 } from "three";
import type { CityEngine } from "../engine/CityEngine";
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
        const { site, at } = encounter;
        const y = site.heights[site.boss.y]?.[site.boss.x] ?? 0;
        point.set(at.x, y + 15, at.z).project(camera);
        const visible = engine.currentLayout === encounter.layout && engine.currentModel === encounter.model && point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
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
