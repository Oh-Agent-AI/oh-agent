import * as THREE from "three";
import type { MonsterEncounter } from "./mecha/monsterEncounters";
import { createBoss, disposeMechaModel } from "../render/mecha/models";

export function createCityMonster(encounter: MonsterEncounter, ground: (x: number, z: number) => number): THREE.Group {
  const { x, z } = encounter.at;
  const feet = [[-13, -7.4], [13, -7.4], [-13.4, 8.2], [13.4, 8.2]];
  const heights = feet.map(([dx, dz]) => ground(x + dx!, z + dz!));
  if (!heights.every(Number.isFinite)) throw new Error("monster ground height unavailable");
  const boss = createBoss();
  boss.name = `city-monster:${encounter.shape}`;
  boss.scale.setScalar(2);
  boss.position.set(x, heights.reduce((sum, height) => sum + height, 0) / heights.length, z);
  boss.updateMatrixWorld(true);
  return boss;
}

export function disposeCityMonster(boss: THREE.Group): void {
  disposeMechaModel(boss);
}
