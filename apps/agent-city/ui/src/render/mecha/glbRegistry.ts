/**
 * 机甲 GLB 资产表 + 加载缓存（Vite 专用：用 ?url 导入资产，随应用离线分发，运行时不联网）。
 * 应用入口调一次 installMechaGlbs()，之后 createAssault() 等会在资产就绪时把程序模型原地升级成 GLB。
 *
 * 失败策略：任何一步（网络、解析、合同校验）出错都只 console.warn 一次并保持程序模型——
 * 资产问题不能让 City 页面或战棋崩掉，也不能让战斗演出换成一个不合格的模型。
 */
import assaultGlbUrl from "../../assets/mecha/assault.glb?url";
import assaultManifestUrl from "../../assets/mecha/assault.manifest.json?url";
import trialGlbUrl from "../../assets/mecha/assault-trial.glb?url";
import trialManifestUrl from "../../assets/mecha/assault-trial.manifest.json?url";
import gunnerGlbUrl from "../../assets/mecha/gunner.glb?url";
import gunnerManifestUrl from "../../assets/mecha/gunner.manifest.json?url";
import supportGlbUrl from "../../assets/mecha/support.glb?url";
import supportManifestUrl from "../../assets/mecha/support.manifest.json?url";
import { MechaGlbError, parseMechaGlb, parseMechaManifest, disposeMechaGlbAsset, type MechaGlbAsset } from "./glbModels";
import { installMechaGlbProvider } from "./models";
import { parseTrialAssault } from "./trialAssault";

type Source = { glb: string; manifest: string; trial?: boolean };
const trialEnabled = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("assaultTrial") === "1";
// Separate local preview for comparing the shorter gait; never used in a match.
const gaitPreview = import.meta.env.DEV && typeof location !== "undefined" && location.pathname.endsWith("/mecha-model.html") && new URLSearchParams(location.search).get("assaultGaitPreview") === "1";
const liftPreview = import.meta.env.DEV && typeof location !== "undefined" && location.pathname.endsWith("/mecha-model.html") && new URLSearchParams(location.search).get("assaultLiftPreview") === "1";
/** 角色 → 资产。要接新角色（规格 §7 的制作顺序）就在这里加一行，并在 glbModels.ts 补它的节点合同。 */
const SOURCES: Record<string, Source> = {
  Assault: liftPreview ? { glb: "/src/assets/mecha/assault-lift-preview.glb", manifest: "/src/assets/mecha/assault-lift-preview.manifest.json", trial: true }
    : gaitPreview ? { glb: "/src/assets/mecha/assault-gait-preview.glb", manifest: "/src/assets/mecha/assault-gait-preview.manifest.json", trial: true }
    : trialEnabled ? { glb: trialGlbUrl, manifest: trialManifestUrl, trial: true } : { glb: assaultGlbUrl, manifest: assaultManifestUrl },
  Gunner: { glb: gunnerGlbUrl, manifest: gunnerManifestUrl },
  Support: { glb: supportGlbUrl, manifest: supportManifestUrl },
};

const pending = new Map<string, Promise<MechaGlbAsset>>();
const ready = new Map<string, MechaGlbAsset>();

async function fetchOk(url: string, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new MechaGlbError(`cannot fetch ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new MechaGlbError(`cannot fetch ${what}: HTTP ${response.status}`);
  return response;
}

async function fetchAsset(role: string, source: Source): Promise<MechaGlbAsset> {
  const [glb, manifestResponse] = await Promise.all([fetchOk(source.glb, `${role} GLB`), fetchOk(source.manifest, `${role} manifest`)]);
  let manifestJson: unknown;
  try {
    manifestJson = await manifestResponse.json();
  } catch (error) {
    throw new MechaGlbError(`${role} manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = parseMechaManifest(manifestJson);
  if (manifest.role !== role) throw new MechaGlbError(`manifest role ${manifest.role} does not match ${role}`);
  const data = await glb.arrayBuffer();
  return source.trial ? parseTrialAssault(data, manifest) : parseMechaGlb(data, manifest);
}

export function loadMechaGlb(role: string): Promise<MechaGlbAsset> {
  const source = SOURCES[role];
  if (!source) return Promise.reject(new MechaGlbError(`no GLB registered for ${role}`));
  let promise = pending.get(role);
  if (!promise) {
    promise = fetchAsset(role, source).then(
      (asset) => { ready.set(role, asset); return asset; },
      (error) => {
        // 只告警一次；失败的 promise 留在缓存里，避免每个实例都重新请求一遍
        console.warn(`[mecha] ${role} GLB unavailable, using the procedural model: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      },
    );
    pending.set(role, promise);
  }
  return promise;
}

/** 提前开始加载（例如进入机甲模式前），让后建的实例一出生就是 GLB。失败已被吞掉，调用方不必处理。 */
export function preloadMechaGlbs(): void {
  for (const role of Object.keys(SOURCES)) loadMechaGlb(role).catch(() => undefined);
}

export function installMechaGlbs(): void {
  installMechaGlbProvider({
    has: (role) => role in SOURCES,
    peek: (role) => ready.get(role) ?? null,
    load: loadMechaGlb,
  });
  preloadMechaGlbs();
}

/** 作废整个缓存并释放共享的 GPU 资源（测试/热更新用；正常运行不需要）。 */
export function disposeMechaGlbCache(): void {
  for (const asset of ready.values()) disposeMechaGlbAsset(asset);
  ready.clear();
  pending.clear();
}
