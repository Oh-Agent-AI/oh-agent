import { atLeast } from "../roadStandard";
import { DetMath as Math } from "../detMath";
/**
 * 用地临街（R5 步 5）：自 cityPlan.ts::buildPlan 逐字迁出的「公共用地 / 地标 选址后挪动」工序段。
 *
 * 顺序（与原内联段一字不差）：组 frontageCtx / shoreCtx → 避高架 → 岸边地标内移 → 跨路（凯旋门）→ 临街 → 重贴干地
 * → 港口贴岸 → 岸边地标贴岸 → 歌剧院离岸 → 联合站点（中央车站 / 东体育场）逐个落位，
 * 落位失败且败于「用地间距」时走一次「可选用地让位」事务重试。
 *
 * 对外部世界的读写（原为 buildPlan 闭包变量，现显式传入）：
 *   读：geo 的 height/coast/coastDistance/landClearance/buildable/terrain/river、core、turn、snap、siteClearance、
 *       trunkRuns、trunkSegments、bridges、ringRuns、inRiver、riverBank、primaryAnchorNodeId、reservations
 *   原地改（保持对象身份与迭代顺序）：publicSites / landmarks（splice/push/挪动坐标）、network（commitNetwork）
 *   新产生并返回：sailOperaCandidateSets（原 `let`，重试时被换成 patch.opera）、siteObligations、jointSiteProgramme
 * random() 不被本段使用。
 */
import type { CityLayout, PublicSite, Vec2 } from "../cityLayout";
import type { Landmark } from "../cityPlan";
import { CONSTRAINTS, type CityPlan as ConstraintPlan } from "./constraints";
import { polylineDistance } from "./footprint";
import { canRelocateGroundSite, specByKind } from "./sitespec";
import { candidatesFor, siteCandidateHardReject, frontSitesOnTrunks, resnapSitesOntoDryLand, restickSitesClearOfRingRuns, straddleSitesAcrossTrunk, groundFrontageSegments, type FrontageMoveContext } from "./access";
import { localResiteCandidates, retreatShoreSitesToDryLand, settleHarborOnCoast, settleSailOperaOffshore, settleShoreSitesOnCoast, type ShoreMoveContext } from "./siting";
import { assignConnectedSite, connectRelocatedPlotAccess, JOINT_SITE_CONFIG } from "./jointSite";
import { footprintRunsDistance, siteFootprint, siteFootprintSeparation } from "../planFootprint";
import { commitNetwork, type Network } from "./network";
import type { buildGeography } from "./geography";

type Geo = ReturnType<typeof buildGeography>;

export type SiteFrontageWorld = {
  geo: Geo;
  core: Vec2;
  turn: number;
  network: Network;
  /** 原地改：splice/push/挪动坐标。 */
  publicSites: PublicSite[];
  /** 原地改：splice/挪动坐标。 */
  landmarks: Landmark[];
  trunkRuns: Vec2[][];
  trunkSegments: Array<readonly [Vec2, Vec2]>;
  ringRuns: Vec2[][];
  bridges: CityLayout["bridges"];
  inRiver: (x: number, z: number) => boolean;
  riverBank: (x: number, z: number, bank: number) => boolean;
  snap: FrontageMoveContext["snap"];
  siteClearance: FrontageMoveContext["siteClearance"];
  primaryAnchorNodeId: string | null;
  reservations: () => Array<PublicSite | Landmark>;
};

export function frontSitesAndAssignJointSites(w: SiteFrontageWorld) {
  const { geo, core, turn, network, publicSites, landmarks, trunkRuns, trunkSegments, ringRuns, bridges, inRiver, snap, siteClearance, primaryAnchorNodeId, reservations } = w;
  const { coast, coastDistance, height, buildable, landClearance, terrain, river } = geo;
  const footprintGeo = { inRiver, riverBank: w.riverBank };
  const frontageCtx: FrontageMoveContext = { publicSites, landmarks, trunkRuns, trunkSegments, ringRuns, height, inRiver: footprintGeo.inRiver, riverBank: footprintGeo.riverBank, buildable, landClearance, snap, siteClearance };
  // 岸线挪动四遍的显式依赖（V2 网络优先 6b-1：遍体逐字迁至 planner/siting.ts；此处只组 ctx，行为不变）。
  const shoreCtx: ShoreMoveContext = { publicSites, landmarks, core, coast, coastDistance, height, inRiver: footprintGeo.inRiver, riverBank: footprintGeo.riverBank, trunkRuns, bridges, ringRuns };
  // 公共用地与地标先于环线选址，名义位置可能正压在高架上（clearsHighways 守卫只覆盖了地块/配套/花园）：
  // 环线只取决于核心点与岛半径，所以这里把压线的预留地原地重新贴到不压高架的位置；街区与地块都在此之后生成。
  restickSitesClearOfRingRuns(frontageCtx);
  // 岸边地标（歌剧院、摩天轮、灯塔、庄园）向核心方向内移，直到占地圈 16 点里落在水上的 ≤3 个——
  // 曾按「离核心最近的海岸点」放下就不管了，约三分之一占地悬在海面上（场景依赖守卫抓到）。港口本就临水，除外。
  retreatShoreSitesToDryLand(shoreCtx);
  // ── 用地临街（R2）：内陆的公共用地与地标贴到最近主干道的一侧（边缘离路肩 6），朝向与道路对齐。
  // 曾在主干道之前按地理选址、之后互不避让：车站中心正压在主干道上，10 个对象没有一个与门前道路对齐。
  // 岸边对象（港口、灯塔、歌剧院、摩天轮）保持海岸位置，稍后补一条入口路。
  // 跨路地标（门式）：凯旋门骑在主干道上、道路从拱券开口穿过——曾与其它用地一样贴到路旁，门下是草地
  // （用户截图：「凯旋门下面不是路？建筑物缺少约束」）。取最近主干道中段，开口轴（局部 z）沿道路方向。
  straddleSitesAcrossTrunk({ ...frontageCtx, groundRoads: [...network.edges.values()].filter(road => !road.bridge),
    trunkSegments: groundFrontageSegments([...network.edges.values()]) });
  frontSitesOnTrunks(frontageCtx);
  // 占地内外两圈 16 个点都得是干地（高于 0.8、不在河道里）：水面渲染还盖住低矮的河岸坡，只看到河道中线的距离不够。
  // 仍不在干地的内陆用地（岸边/跨路/广场豁免，各有专属遍或构造保证）重贴到干地。
  resnapSitesOntoDryLand(frontageCtx);
  // 港口最后贴回岸线：前面的避让（离其它用地、离环线高架）会把它推进内陆，港口离水上百（用户截图：港口在市中心）。
  // 朝最近的岸点逐步移动，直到中心离岸 ≤ 12（码头半边伸进水面）。
  settleHarborOnCoast(shoreCtx);
  // 岸边地标（帆形歌剧院、灯塔、摩天轮、庄园）同样贴回岸线（用户：「类似悉尼歌剧院的建筑不是应该在水边吗」）：
  // 朝最近岸点移动到中心离岸 ≈ 0.7 半径，同时占地圈 16 点落水不超过 3（立在水边、不悬空）。
  settleShoreSitesOnCoast(shoreCtx);
  // 帆形歌剧院改立在海上小岛、以堤道连岸（用户：「歌剧院不应该在河里，需要在海上」「范式和机场一样」）。
  // 取离当前位置最近的几个岸点，岸外 radius+40 处整个占地圈必须是深水（不在河口），且离港口/其它用地够远。
  let sailOperaCandidateSets = settleSailOperaOffshore(shoreCtx);
  const siteObligations: Array<{ ownerId: string; placed: boolean; reason?: string; routeRetries?: number }> = [];
  const jointSiteProgramme = [["central-station", "station"], ["east-stadium", "stadium"]] as const;
  for (const [ownerId, kind] of jointSiteProgramme) {
    let assigned = assignConnectedSite({ ...geo, core, turn, trunkRuns, ringRuns, bridges, placed: [...publicSites, ...landmarks], height, inRiver,
      riverBank: footprintGeo.riverBank }, { network, geo, inRiver, reservations }, specByKind(kind)!, ownerId, primaryAnchorNodeId);
    let relocationFailure: string | undefined;
    if (!assigned.site && assigned.reason?.includes("site-spacing")) {
      type RelocationPatch = { publicSites: PublicSite[]; landmarks: Landmark[]; opera: typeof sailOperaCandidateSets };
      const patches = new Map<string, RelocationPatch>();
      const currentSites = [...publicSites, ...landmarks].filter((site) => site.radius);
      const separation = (a: typeof currentSites[number], b: typeof currentSites[number]) => siteFootprintSeparation(a, b);
      const overlapCount = (sites: typeof currentSites) => {
        let count = 0;
        for (let i = 0; i < sites.length; i += 1) for (let j = i + 1; j < sites.length; j += 1) {
          if (separation(sites[i], sites[j]) < 0) count += 1;
        }
        return count;
      };
      const baselineOverlaps = overlapCount(currentSites);
      const siteHasRoadOverlap = (site: typeof currentSites[number], candidateNetwork: Network) => {
        if (site.kind === "civic" || site.kind === "arch") return false;
        const footprint = siteFootprint(site.kind, site.id, site.radius);
        if (footprint.exact) return [...candidateNetwork.edges.values()].some((edge) =>
          footprintRunsDistance(footprint, site, site.yaw, [edge.points]) < edge.width / 2 + 3);
        return polylineDistance([...candidateNetwork.edges.values()].map((edge) => edge.points), site) < site.radius * 0.7;
      };
      const countRoadOverlaps = (sites: typeof currentSites, candidateNetwork: Network) => sites.filter((site) => siteHasRoadOverlap(site, candidateNetwork)).length;
      const baselineRoadOverlaps = countRoadOverlaps(currentSites, network);
      const relocationRejects = new Map<string, number>();
      let neighbourAccessEvaluations = 0;
      const noteRelocationReject = (reason: string) => relocationRejects.set(reason, (relocationRejects.get(reason) ?? 0) + 1);
      const ownerRules = CONSTRAINTS.filter((constraint) => ["siteInWater", "siteWithoutDoorRoad", "roadThroughSite",
        "sitesOverlap", "stationStadiumSetback", "stationDoorFacesRoad", "archStraddlesRoad"].includes(constraint.id));
      const ownerView = (candidateNetwork: Network, sites: PublicSite[], marks: Landmark[]) => ({
        roadEdges: [...candidateNetwork.edges.values()], roadNodes: [...candidateNetwork.nodes.values()], publicSites: sites, landmarks: marks,
        blocks: [], terrain, core, coast, river, waterEdges: (geo as { waterEdges?: Vec2[][] }).waterEdges ?? [], seaside: null, coastRoads: [], riverRoadRuns: [], primaryAnchorNodeId,
      } as unknown as ConstraintPlan);
      const ownerIdentity = (violation: ReturnType<typeof ownerRules[number]["measure"]>[number], sites: typeof currentSites) =>
        violation.identity ?? sites.find((site) => site.kind === violation.site && site.x === violation.at?.x && site.z === violation.at?.z)?.id
        ?? JSON.stringify([violation.site, violation.at, violation.detail]);
      const previousOwnerFailures = new Map(ownerRules.map((constraint) => [constraint.id,
        new Set(constraint.measure(ownerView(network, publicSites, landmarks)).map((violation) => ownerIdentity(violation, currentSites)))]));
      const moveOptionalSites = (owner: PublicSite, candidateNetwork: Network): string | null => {
        const stagedPublic = publicSites.map((site) => ({ ...site, ...(site.access ? { access: { ...site.access } } : {}) }));
        const stagedLandmarks = landmarks.map((site) => ({ ...site, ...("shore" in site && site.shore ? { shore: { ...site.shore } } : {}) }));
        stagedPublic.push(owner);
        const initialSites = [...stagedPublic, ...stagedLandmarks].filter((site) => site.radius);
        const initialOwner = initialSites.find((site) => site.id === ownerId)!;
        const candidateRoads = [...candidateNetwork.edges.values()].map((edge) => edge.points);
        const blockerIds = new Set(initialSites.filter((site) => site !== initialOwner && (
          separation(site, initialOwner) < 10
          || siteHasRoadOverlap(site, candidateNetwork)
        )).map((site) => site.id));
        if (blockerIds.size > 0) {
          const fixedBlocker = initialSites.find((site) => blockerIds.has(site.id)
            && (site.kind === "civic" || site.kind === "harbor" || ("access" in site && site.access)));
          if (fixedBlocker) return `site-relocation-fixed-blocker(${fixedBlocker.id})`;
          const actualTrunks = [...candidateNetwork.edges.values()].filter((edge) => !edge.bridge && atLeast(edge, "collector")).map((edge) => edge.points);
          const actualSegments = actualTrunks.flatMap((run) => run.slice(1).map((point, index) => [run[index], point] as [Vec2, Vec2]));
          const stagedFrontage = { ...frontageCtx, trunkRuns: actualTrunks, trunkSegments: actualSegments,
            publicSites: stagedPublic, landmarks: stagedLandmarks, relocateSiteIds: blockerIds };
          const stagedShore = { ...shoreCtx, publicSites: stagedPublic, landmarks: stagedLandmarks, relocateSiteIds: blockerIds,
            neighbourMargins: new Map([[ownerId, 10]]), trunkRuns: actualTrunks, roadEnvelopes: [...candidateNetwork.edges.values()] };
          restickSitesClearOfRingRuns(stagedFrontage);
          const archSegments = groundFrontageSegments([...candidateNetwork.edges.values()]);
          straddleSitesAcrossTrunk({ ...stagedFrontage, groundRoads: [...candidateNetwork.edges.values()].filter(road => !road.bridge),
            trunkSegments: archSegments });
          frontSitesOnTrunks(stagedFrontage);
          resnapSitesOntoDryLand(stagedFrontage);
          settleShoreSitesOnCoast(stagedShore);
          const stagedOpera = [...stagedLandmarks].some((site) => blockerIds.has(site.id) && site.kind === "sail-opera")
            ? settleSailOperaOffshore(stagedShore) : sailOperaCandidateSets;
          // The legacy movement passes do not reposition every relocatable class
          // (for example, a dry park may have no frontage/wet/foundation violation).
          // When it still blocks a required owner, search that model's declared,
          // bounded placement candidates against the complete staged site set.
          const requiredOwner = [...stagedPublic, ...stagedLandmarks].find((site) => site.id === ownerId)!;
          const actualPlaced = [...stagedPublic, ...stagedLandmarks].filter((site) => site.radius);
          const movableBlockers = [...blockerIds].sort().map((id) => actualPlaced.find((site) => site.id === id))
            .filter((site): site is typeof actualPlaced[number] => !!site
              && Math.hypot(site.x - requiredOwner.x, site.z - requiredOwner.z) < site.radius + requiredOwner.radius + 10);
          if (movableBlockers.length > 2) noteRelocationReject("joint-blocker-node-budget-exhausted");
          else if (movableBlockers.length) {
            const movableIds = new Set(movableBlockers.map((site) => site.id));
            const fixedPlaced = actualPlaced.filter((site) => !movableIds.has(site.id));
            const options: Array<Array<{ site: typeof movableBlockers[number]; spec: NonNullable<ReturnType<typeof specByKind>>; candidate: ReturnType<typeof candidatesFor>[number] }>> = [];
            let invalidBlocker = false;
            for (const blocker of movableBlockers) {
              const spec = specByKind(blocker.kind);
              if (!canRelocateGroundSite(blocker) || !spec) { noteRelocationReject(`${blocker.id}:immovable-or-unregistered`); invalidBlocker = true; break; }
              const placementWorld = { ...geo, core, turn, trunkRuns: actualTrunks, ringRuns, bridges, inRiver, riverBank: footprintGeo.riverBank,
                placed: fixedPlaced, usePlacedFootprints: true };
              const generated = [...candidatesFor(placementWorld, spec, blocker),
                ...[...localResiteCandidates(blocker)].map((at, index) => ({ ...at, yaw: blocker.yaw,
                  id: `required-owner-relocation:${blocker.id}:${index}`, source: "declared-local-resite" }))];
              const admitted: typeof options[number] = [];
              for (const candidate of generated) {
                const hardFailure = siteCandidateHardReject(placementWorld, spec, candidate);
                if (hardFailure) { noteRelocationReject(`${blocker.id}:${hardFailure}`); continue; }
                const roadDistance = Math.min(...candidateRoads.map((run) => polylineDistance([run], candidate)));
                if (roadDistance > spec.radius + 8 + spec.radius + 30) { noteRelocationReject(`${blocker.id}:door-road-distance`); continue; }
                admitted.push({ site: blocker, spec, candidate });
              }
              admitted.sort((a, b) => Math.hypot(a.candidate.x - blocker.x, a.candidate.z - blocker.z)
                - Math.hypot(b.candidate.x - blocker.x, b.candidate.z - blocker.z)
                || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0));
              options.push(admitted.slice(0, 64));
              if (!admitted.length) noteRelocationReject(`${blocker.id}:no-hard-admissible-candidate`);
            }
            if (!invalidBlocker && options.every((list) => list.length)) {
              const selected: typeof options[number] = [];
              let accepted = false;
              const search = (index: number) => {
                if (accepted) return;
                if (index < options.length) { for (const option of options[index]) { selected.push(option); search(index + 1); selected.pop(); if (accepted) break; } return; }
                const targetById = new Map(selected.map((entry) => [entry.site.id, entry.candidate]));
                const completePlaced = actualPlaced.filter((site) => !movableIds.has(site.id));
                for (const entry of selected) completePlaced.push({ ...entry.site, x: entry.candidate.x, z: entry.candidate.z,
                  yaw: entry.candidate.yaw, radius: entry.spec.radius });
                for (const entry of selected) {
                  const world = { ...geo, core, turn, trunkRuns: actualTrunks, ringRuns, bridges, inRiver, riverBank: footprintGeo.riverBank,
                    usePlacedFootprints: true,
                    placed: completePlaced.filter((site) => site.x !== targetById.get(entry.site.id)!.x || site.z !== targetById.get(entry.site.id)!.z) };
                  if (siteCandidateHardReject(world, entry.spec, entry.candidate)) { noteRelocationReject(`${entry.site.id}:joint-final-hard-check`); return; }
                  if (Math.min(...candidateRoads.map((run) => polylineDistance([run], entry.candidate))) > entry.spec.radius + 8 + entry.spec.radius + 30) {
                    noteRelocationReject(`${entry.site.id}:joint-final-door-road`); return;
                  }
                }
                const prior = selected.map(({ site }) => ({ site, x: site.x, z: site.z, yaw: site.yaw }));
                for (const entry of selected) { entry.site.x = entry.candidate.x; entry.site.z = entry.candidate.z; entry.site.yaw = entry.candidate.yaw; }
                const trialSites = [...stagedPublic, ...stagedLandmarks].filter((site) => site.radius);
                const trialNetwork: Network = { ...candidateNetwork,
                  ...(candidateNetwork.patchRemaps ? { patchRemaps: [...candidateNetwork.patchRemaps] } : {}),
                  nodes: new Map([...candidateNetwork.nodes].map(([id, node]) => [id, { ...node }])),
                  edges: new Map([...candidateNetwork.edges].map(([id, edge]) => [id, { ...edge, points: edge.points.map(point => ({ ...point })) }])) };
                const spacingConflict = trialSites.some((site) => site !== requiredOwner
                  && separation(site, requiredOwner) < 10);
                const served = !spacingConflict && selected.every(entry => {
                  if (Math.min(...candidateRoads.map(run => polylineDistance([run], entry.site))) > entry.site.radius + 20
                    && ++neighbourAccessEvaluations > JOINT_SITE_CONFIG.maxNeighbourAccessEvaluations) {
                    noteRelocationReject("joint-neighbour-access-budget-exhausted"); return false;
                  }
                  return connectRelocatedPlotAccess({ network: trialNetwork, geo, inRiver,
                    reservations: () => trialSites }, entry.site, primaryAnchorNodeId);
                });
                const introducedFinding = spacingConflict || !served ? null : ownerRules.flatMap((constraint) => constraint.measure(ownerView(trialNetwork, stagedPublic, stagedLandmarks))
                  .filter((violation) => !previousOwnerFailures.get(constraint.id)!.has(ownerIdentity(violation, trialSites)))
                  .map((violation) => ({ constraint, violation })))[0] ?? null;
                const introducedConstraint = introducedFinding?.constraint ?? null;
                const newViolation = !!introducedConstraint;
                if (!spacingConflict && served && !newViolation) {
                  candidateNetwork.nodes.clear(); for (const [id, node] of trialNetwork.nodes) candidateNetwork.nodes.set(id, node);
                  candidateNetwork.edges.clear(); for (const [id, edge] of trialNetwork.edges) candidateNetwork.edges.set(id, edge);
                  candidateNetwork.patchRemaps = trialNetwork.patchRemaps;
                  accepted = true; return;
                }
                noteRelocationReject(spacingConflict ? "joint-blockers:owner-spacing" : !served ? "joint-blockers:service-route-refused"
                  : `joint-blockers:new-${introducedConstraint?.id ?? "owner-constraint"}:${introducedFinding ? ownerIdentity(introducedFinding.violation, trialSites) : "unknown"}`);
                for (const entry of prior) { entry.site.x = entry.x; entry.site.z = entry.z; entry.site.yaw = entry.yaw; }
              };
              search(0);
              if (!accepted) noteRelocationReject("joint-blockers:no-accepted-combination");
            }
          }
          const stagedSites = [...stagedPublic, ...stagedLandmarks].filter((site) => site.radius);
          const stagedOwner = stagedSites.find((site) => site.id === ownerId)!;
          const ownerSpacingBlockers = stagedSites.filter((site) => site !== stagedOwner
            && separation(site, stagedOwner) < 10);
          const ownerSpacingConflict = ownerSpacingBlockers.length > 0;
          const roadOverlaps = countRoadOverlaps(stagedSites, candidateNetwork);
          if (ownerSpacingConflict || overlapCount(stagedSites) > baselineOverlaps || roadOverlaps > baselineRoadOverlaps) {
            const evidence = [...relocationRejects].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason}=${count}`).join(",");
            return `site-relocation-refused(ownerSpacing=${ownerSpacingConflict},siteOverlaps=${overlapCount(stagedSites)}>${baselineOverlaps},roadOverlaps=${roadOverlaps}>${baselineRoadOverlaps}) blockers=[${ownerSpacingBlockers.map((site) => site.id).join(",")}] relocation=[${evidence}]`;
          }
          for (const constraint of ownerRules) if (constraint.measure(ownerView(candidateNetwork, stagedPublic, stagedLandmarks))
            .some((violation) => !previousOwnerFailures.get(constraint.id)!.has(ownerIdentity(violation, stagedSites)))) return `site-relocation-new-${constraint.id}`;
          patches.set(ownerId, { publicSites: stagedPublic, landmarks: stagedLandmarks, opera: stagedOpera });
        } else patches.set(ownerId, { publicSites: stagedPublic, landmarks: stagedLandmarks, opera: sailOperaCandidateSets });
        return null;
      };
      const stagedPublic = publicSites.map((site) => ({ ...site, ...(site.access ? { access: { ...site.access } } : {}) }));
      const stagedLandmarks = landmarks.map((site) => ({ ...site, ...("shore" in site && site.shore ? { shore: { ...site.shore } } : {}) }));
      const fixed = [...stagedPublic, ...stagedLandmarks].filter((site) => site.kind === "civic" || site.kind === "harbor" || ("access" in site && site.access));
      const retry = assignConnectedSite({ ...geo, core, turn, trunkRuns, ringRuns, bridges, placed: fixed, height, inRiver,
        riverBank: footprintGeo.riverBank }, { network, geo, inRiver, reservations: () => fixed }, specByKind(kind)!, ownerId, primaryAnchorNodeId, moveOptionalSites);
      if (retry.site && retry.network) {
        const patch = patches.get(ownerId);
        if (!patch) throw new Error(`missing site relocation patch for ${ownerId}`);
        publicSites.splice(0, publicSites.length, ...patch.publicSites);
        landmarks.splice(0, landmarks.length, ...patch.landmarks);
        sailOperaCandidateSets = patch.opera;
        assigned = retry;
      } else relocationFailure = `relocation retry: ${retry.reason ?? "no connected candidate"}`;
    }
    siteObligations.push({ ownerId, placed: !!assigned.site, ...(assigned.routeRetries ? { routeRetries: assigned.routeRetries } : {}),
      ...(!assigned.site ? { reason: [assigned.reason, relocationFailure].filter(Boolean).join("; ") } : {}) });
    if (!assigned.site || !assigned.network) continue;
    commitNetwork(network, assigned.network);
    if (!publicSites.some((site) => site.id === assigned.site!.id)) publicSites.push(assigned.site);
  }
  return { sailOperaCandidateSets, siteObligations, jointSiteProgramme };
}
