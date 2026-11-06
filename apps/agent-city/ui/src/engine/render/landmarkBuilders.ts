import type { LandmarkCtx } from "../models/landmarkContext";
import { hashSeed } from "../../cityModel";
import { compiledBuilder } from "./buildingCompiler";
import type { BuildingModel } from "../models/model";
import { tvTowerModel } from "../models/landmarks/tvTower";
import { archModel } from "../models/landmarks/arch";
import { sailOperaModel } from "../models/landmarks/sailOpera";
import { lighthouseModel } from "../models/landmarks/lighthouse";
import { ferrisWheelModel } from "../models/landmarks/ferrisWheel";
import { pagodaModel } from "../models/landmarks/pagoda";
import { drawTwinTowers } from "./landmarks/twinTowers";
import { drawTwistTower } from "./landmarks/twistTower";
import { drawVillaComplex } from "./landmarks/villaComplex";
import { drawIsletMansion } from "./landmarks/isletMansion";
import { drawIsletGrounds } from "./landmarks/isletGrounds";
import { drawSuspensionBridge } from "./landmarks/suspensionBridge";

const modelBuilder = (model: BuildingModel) => compiledBuilder(model, hashSeed);

/**
 * 地标造型函数表：每个 kind 一个 (ctx) => void，cityParts / landmarkSystem 只按 kind 查表调用。
 * 从 models/registry.ts 迁来（L3 不得值导入 three/render）：声明数据（BUILDING_MODELS、UNPARADIGMED、标签）留在 registry，
 * 这里是 L4 渲染侧「声明 → three 对象」的接线。键序即历史注册序，勿改。
 */
export const LANDMARK_BUILDERS: Record<string, (ctx: LandmarkCtx) => void> = {
  "tv-tower": modelBuilder(tvTowerModel),
  "twin-towers": drawTwinTowers,
  "twist-tower": drawTwistTower,
  "arch": modelBuilder(archModel),
  "sail-opera": modelBuilder(sailOperaModel),
  "lighthouse": modelBuilder(lighthouseModel),
  "ferris-wheel": modelBuilder(ferrisWheelModel),
  "pagoda": modelBuilder(pagodaModel),
  "villa-complex": drawVillaComplex,
  "islet-mansion": drawIsletMansion,
  "islet-grounds": drawIsletGrounds,
  "suspension-bridge": drawSuspensionBridge,
};
