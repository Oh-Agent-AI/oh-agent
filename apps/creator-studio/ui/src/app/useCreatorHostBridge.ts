import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { connectHostCalls, observeHealth } from "@agent-vitals/app-sdk/ui-host";
import { applyCityWorldOperations } from "../cityWorldOperations";
import { assertCityPlanPlayable } from "../cityPlanPreflight";
import { inspectInstalledWorld, supportsInstalledWorldGenerator } from "../contentSnapshot";
import { parseInstalledPackages } from "../installedContent";
import { resolveSceneCaptureRevision } from "../publicationSync";
import { buildGameValidation, buildSceneValidation, buildVehicleValidation, normalizeVehicleProfileInput, scopeMismatchEnvelope } from "../sdkValidation";
import { creatorRequest } from "../adapters/creatorHost";
import { digest } from "../adapters/creatorHostUtils";
import type { AgentActivityItem } from "../features/agent/useAgentActivity";
import type { AgentApprovalGate, AgentCommit } from "../features/agent/agentApproval";
import type { ApplyProject, CityDiagnosticContext, CityViewOpenResult, CityViewStatus, Project, StudioPanel } from "../contracts/creatorStudio";
import { estimateVehiclePerformanceV1, validateCityInstance, validateCityLayoutScope, validateMiniGamePack, validateMount, validateSceneDraft, validateVehicleProfileV1, validateWorldPlanPatch, type CityInstanceV1, type CityWorldProfileV1 } from "@oh-agent/city-sdk";
import { createCreatorLayoutSnapshot, createScopedCreatorLayoutSnapshot } from "../../../../agent-city/ui/src/engine/sdk/cityLayoutAdapter";
import type { CityEngine } from "../../../../agent-city/ui/src/engine/CityEngine";
import { CITY_GENERATOR_VERSION } from "../../../../agent-city/ui/src/engine/planPatch";

type CreatorHostBridgeOptions = Readonly<{
  projectRef: RefObject<Project | null>;
  applyRef: RefObject<ApplyProject>;
  studioEngineRef: RefObject<CityEngine | null>;
  draftCityViewRef: RefObject<CityInstanceV1 | null>;
  draftEngineRef: RefObject<CityEngine | null>;
  draftViewStatusRef: RefObject<CityViewStatus>;
  draftViewFailureRef: RefObject<string | undefined>;
  draftDiagnosticsRef: RefObject<CityDiagnosticContext | null>;
  approvalGate: RefObject<AgentApprovalGate>;
  openCityView: (cityId: string, revision: number) => Promise<CityViewOpenResult>;
  recordCityDiagnostic: (city: CityInstanceV1, event: string, code?: string) => Promise<void>;
  recordAgentActivity: (item: AgentActivityItem) => void;
  restoreAgentActivity: () => Promise<void>;
  setAgentCommit: Dispatch<SetStateAction<AgentCommit | null>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setActivePanel: (panel: StudioPanel) => void;
}>;

export function useCreatorHostBridge(options: CreatorHostBridgeOptions) {
  const {
    projectRef, applyRef, studioEngineRef, draftCityViewRef, draftEngineRef, draftViewStatusRef, draftViewFailureRef, draftDiagnosticsRef,
    approvalGate, openCityView, recordCityDiagnostic, recordAgentActivity, restoreAgentActivity, setAgentCommit, setMessage, setActivePanel,
  } = options;

  useEffect(() => {
    const methods = ["creator.city.create", "creator.city.create_from_world", "creator.city.draft.create", "creator.city.draft.read", "creator.city.draft.cancel", "creator.city.draft.commit",
      "creator.city.archive.preview", "creator.city.archive.commit", "creator.city.archive.list", "creator.city.archive.restore", "creator.city.diagnostic.list", "creator.city.edit.preview", "creator.city.patch.preview", "creator.city.edit.commit", "creator.city.list", "creator.city.read", "creator.layout.list", "creator.project.list", "creator.project.read", "creator.project.read_chunk", "creator.operation.status", "creator.project.create",
      "creator.game.preview", "creator.asset.import", "creator.game.commit", "creator.scene.preview", "creator.scene.commit", "creator.project.commit", "creator.project.publish", "creator.project.publication",
      "creator.project.candidate.create", "creator.project.candidate.read", "creator.project.candidate.accept",
      "creator.project.playtest.start", "creator.project.playtest.result", "creator.project.playtest.cancel", "creator.project.playtest.return_context", "creator.project.playtest.history",
      "creator.scene.describe", "creator.scene.inspect", "creator.scene.validate", "creator.capabilities.list",
      "creator.vehicle.preview", "creator.vehicle.define", "creator.vehicle.inspect",
      "creator.city.anchor.list", "creator.city.anchor.upsert", "creator.city.anchor.remove",
      "creator.mount.list", "creator.mount.bind", "creator.mount.unbind", "creator.game.bind.preview",
      "creator.experience.build", "creator.experience.list", "creator.experience.install", "creator.experience.uninstall",
      // Story Project Registry（RFC V3 §12，S-2+S-3）：MCP 的 story.* 调用经 Studio
      // 透传到宿主 dispatch；写授权仍由宿主 dispatch 行与 MCP 闸各自执行。
      "creator.story.project.create", "creator.story.project.read", "creator.story.projects.list",
      "creator.story.install.preview", "creator.story.install.commit", "creator.story.install.list",
      "creator.story.run.start", "creator.story.run.stop", "creator.story.run.reset",
      "creator.story.resident.lease.acquire", "creator.story.resident.lease.release"];
    // 这些调用只能来自宿主/MCP 路由（UI 自己的请求直连宿主、不经此转发），
    // 所以这里的捕获天然就是「Agent 来源」的变更记录——设计 §7.3 的变更卡片数据源。
    const noteAgent = (method: string, payload: Record<string, unknown>, ok: boolean, result: unknown) => {
      const labels: Record<string, string> = {
        "creator.project.create": "新建项目", "creator.game.preview": "规则预览", "creator.scene.preview": "场景预览",
        "creator.game.commit": "提交规则", "creator.scene.commit": "提交场景", "creator.project.commit": "Agent 提交",
        "creator.project.publish": "发布到 City", "creator.project.candidate.create": "创建 Candidate", "creator.project.candidate.accept": "接受 Candidate 并发布", "creator.project.playtest.start": "请求试玩",
        "creator.project.playtest.cancel": "取消试玩", "creator.asset.import": "导入模型",
        "creator.scene.capture": "视口捕获",
        "creator.vehicle.preview": "飞行器预览", "creator.vehicle.define": "定义飞行器", "creator.vehicle.inspect": "检视飞行器",
      };
      const label = labels[method];
      if (!label) return;
      let summary = "";
      if (method === "creator.scene.preview" && Array.isArray(payload.operations)) {
        const counts = new Map<string, number>();
        for (const operation of payload.operations as Array<{ op?: string }>) {
          const kind = String(operation.op ?? "unknown").split(".")[0];
          counts.set(kind, (counts.get(kind) ?? 0) + 1);
        }
        summary = [...counts.entries()].map(([kind, count]) => `${kind}×${count}`).join("、");
      } else if (typeof payload.releaseId === "string") summary = payload.releaseId;
      else if (typeof payload.candidateId === "string") summary = `Candidate ${payload.candidateId}`;
      const revision = (result as { revision?: number } | null)?.revision;
      recordAgentActivity({ method, label, summary, ok, revision, at: Date.now() });
    };
    // P2 语义搬运（设计 §5.2）：Agent 来源的 preview 在转发前经 Studio 的 city-sdk
    // 校验并附加 validation 信封；Rust 签发时核对作用域（projectId/baseRevision/
    // payloadDigest）并原子绑定结论，commit 闸门据此放行。校验目标必须与请求的
    // projectId/baseRevision 一致（审查修复）：不是当前打开的项目时取权威文档，
    // 取不到或 revision 漂移按判负出信封。
    const attachValidation = async (method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === "creator.city.create" || method === "creator.city.draft.create" || method === "creator.city.draft.commit") {
        const request = { name: payload.name, seed: payload.seed, profile: payload.profile, operationId: payload.operationId };
        const checked = validateCityInstance({ schemaVersion: 1, cityId: "city-validation", revision: 0,
          name: request.name, seed: request.seed, profile: request.profile });
        if (checked.ok) assertCityPlanPlayable(request.seed, request.profile);
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok: checked.ok } };
      }
      if (method === "creator.city.create_from_world") {
        const request = { name: payload.name, operationId: payload.operationId, packageId: payload.packageId, version: payload.version };
        let ok = false;
        try {
          const available = parseInstalledPackages(await creatorRequest<unknown>("creator.content.list", {})) ?? [];
          const item = available.find(candidate => candidate.packageId === request.packageId && candidate.version === request.version);
          if (!item) throw new Error("content_package_not_found");
          const world = await inspectInstalledWorld(creatorRequest, item);
          if (!("defaultSeed" in world.manifest.entry)) throw new Error("content_snapshot_invalid");
          const checked = validateCityInstance({ schemaVersion: 1, cityId: "city-validation", revision: 0,
            name: request.name, seed: world.manifest.entry.defaultSeed, profile: world.profile });
          const boundRequest = { ...request, contentDigest: item.contentDigest };
          ok = supportsInstalledWorldGenerator(world.manifest) && checked.ok;
          return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(boundRequest), ok } };
        } catch { /* Fail closed below with a validation bound to no usable package content. */ }
        const boundRequest = { ...request, contentDigest: null };
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(boundRequest), ok } };
      }
      if (method === "creator.city.edit.preview") {
        // world.set 形态（世界多样化规格 §5.2）：operations 与 name/seed 配方替换
        // 互斥（宿主同样拒绝）。语义合并以 city-sdk 为单一来源：读权威文档、按
        // 生成器落位（arid legacy 键→dunes，其余→diversity；coastal→coastal 字段），
        // 合并结果经 validateCityWorldProfile 复验；摘要绑定 profile+operations。
        // 任何失败按判负出信封（ok=false），结构侧稳定错误码（world_params_* 等）
        // 由宿主先行给出。
        if (Array.isArray(payload.operations)) {
          let fallbackProfile: unknown = {};
          let merged: CityWorldProfileV1 | null = null;
          try {
            const city = validateCityInstance(await creatorRequest<unknown>("creator.city.read", { cityId: payload.cityId }));
            if (city.ok) {
              fallbackProfile = city.value.profile;
              if (city.value.revision === payload.baseRevision) {
                merged = applyCityWorldOperations(city.value.profile, payload.operations);
              }
            }
          } catch { merged = null; }
          const request = { cityId: payload.cityId, baseRevision: payload.baseRevision,
            profile: merged ?? fallbackProfile, operations: payload.operations };
          return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok: merged !== null } };
        }
        const request = { cityId: payload.cityId, baseRevision: payload.baseRevision, name: payload.name, seed: payload.seed, profile: payload.profile };
        const checked = validateCityInstance({ schemaVersion: 1, cityId: request.cityId, revision: request.baseRevision,
          name: request.name, seed: request.seed, profile: request.profile });
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok: checked.ok } };
      }
      if (method === "creator.city.patch.preview") {
        const request = { cityId: payload.cityId, baseRevision: payload.baseRevision, patch: payload.patch };
        let ok = false;
        try {
          const city = validateCityInstance(await creatorRequest<unknown>("creator.city.read", { cityId: request.cityId }));
          ok = city.ok && city.value.revision === request.baseRevision && (request.patch === null || validateWorldPlanPatch(request.patch, city.value.seed, CITY_GENERATOR_VERSION).ok);
        } catch { ok = false; }
        return { ...request, validation: { schemaVersion: 1, requestDigest: await digest(request), ok } };
      }
      // 车辆定义/预览（2026-11-15 泛化切片）：define 面发送展平字段、preview 面发送
      // `vehicle` 对象；统一归一化为完整 VehicleProfileV1（camera 缺省 = 确定性默认
      // 公式），SDK 判定后按完整 profile 出信封——宿主 scope 核对与结构硬闸都以
      // 这份载荷为准。modelAssetId 只透传（null 或项目 assetId），本面不接本地路径。
      if (method === "creator.vehicle.preview" || method === "creator.vehicle.define") {
        const outcome = normalizeVehicleProfileInput(payload.vehicle ?? payload);
        const validation = await buildVehicleValidation(String(payload.projectId ?? ""), Number(payload.baseRevision ?? 0), outcome);
        // The host dispatch accepts exactly the preview/define contract keys; the
        // flattened MCP arguments (label/physics/bounds/...) must not leak through.
        return method === "creator.vehicle.define"
          ? { projectId: payload.projectId, baseRevision: payload.baseRevision, vehicleId: payload.vehicleId,
              vehicle: outcome.vehicle, operationId: payload.operationId, validation }
          : { projectId: payload.projectId, baseRevision: payload.baseRevision, vehicle: outcome.vehicle, validation };
      }
      const projectId = String(payload.projectId ?? "");
      const baseRevision = Number(payload.baseRevision ?? 0);
      if (method === "creator.game.preview") {
        return { ...payload, validation: await buildGameValidation(projectId, baseRevision, payload.game) };
      }
      if (method === "creator.scene.preview") {
        let document: Project | null = projectRef.current?.projectId === projectId ? projectRef.current : null;
        if (!document) {
          try { document = await creatorRequest<Project>("creator.project.read", { projectId }); }
          catch { document = null; }
        }
        if (!document || document.revision !== baseRevision) {
          const message = !document ? "预览目标项目不存在或 Studio 无法读取，无法完成语义校验。"
            : `预览目标 revision ${baseRevision} 与项目当前 revision ${document.revision} 不一致，无法完成语义校验。`;
          return { ...payload, validation: scopeMismatchEnvelope(projectId, baseRevision, "creator_validation_scope_mismatch", message) };
        }
        return { ...payload, validation: await buildSceneValidation(document, projectId, baseRevision, payload.operations) };
      }
      return payload;
    };
    const handlers = Object.fromEntries(methods.map(method => [method, async (payload: Record<string, unknown>) => {
      let result: unknown;
      try {
        if (method === "creator.operation.status" && approvalGate.current.isPending(payload.projectId, payload.operationId)) {
          return { status: "awaiting_confirmation" };
        }
        if (["creator.project.commit", "creator.game.commit", "creator.scene.commit"].includes(method)) {
          const commit = approvalGate.current.request(method, payload);
          setAgentCommit(commit);
          setMessage("Agent 请求保存更改，请在 Agent 面板检查并确认。");
          setActivePanel("agent");
          throw new Error("creator_confirmation_required");
        }
        const checkedPayload = await attachValidation(method, payload);
        result = await creatorRequest(method, checkedPayload);
        // 性能投影的归属是 city-sdk：宿主只回事实，Studio 在这里补上 Agent 看的
        // `estimatedPerformance`（与引擎消费的是同一个 pure 函数，不是第三份公式）。
        if (method === "creator.vehicle.preview" && result && typeof result === "object"
          && checkedPayload && typeof checkedPayload === "object") {
          const checkedVehicle = validateVehicleProfileV1((checkedPayload as Record<string, unknown>).vehicle);
          if (checkedVehicle.ok) {
            result = { ...(result as Record<string, unknown>), estimatedPerformance: estimateVehiclePerformanceV1(checkedVehicle.value) };
          }
        }
        if ((method === "creator.game.preview" || method === "creator.scene.preview") && result && typeof result === "object") {
          const preview = result as { previewId?: unknown; projectId?: unknown; baseRevision?: unknown; expiresInMs?: unknown; changedObjects?: unknown };
          const validation = checkedPayload.validation as { ok?: unknown } | undefined;
          if (typeof preview.previewId === "string" && typeof preview.projectId === "string" && typeof preview.baseRevision === "number"
            && typeof preview.expiresInMs === "number" && preview.expiresInMs > 0 && validation?.ok === true) {
            const operations = Array.isArray(payload.operations) ? payload.operations.length : 0;
            const details = Array.isArray(preview.changedObjects) ? preview.changedObjects.slice(0, 10).flatMap(item => {
              if (!item || typeof item !== "object") return [];
              const value = item as Record<string, unknown>;
              return typeof value.id === "string" && typeof value.action === "string" ? [`${value.action.slice(0, 32)} · ${value.id.slice(0, 128)}`] : [];
            }) : [];
            const cityOperations = Array.isArray(payload.operations) ? payload.operations.filter(item => item && typeof item === "object" && (item.op === "city.patch.upsert" || item.op === "city.patch.remove")) : [];
            const singleCityPatch = cityOperations.length === 1 && operations === 1 && cityOperations[0].op === "city.patch.upsert" ? cityOperations[0].patch : undefined;
            approvalGate.current.remember({ previewId: preview.previewId, projectId: preview.projectId, revision: preview.baseRevision,
              kind: method === "creator.game.preview" ? "game" : "scene", summary: method === "creator.game.preview" ? "玩法规则修改" : `场景修改（${operations} 项操作）`,
              details, changes: JSON.stringify(method === "creator.game.preview" ? payload.game : payload.operations, null, 2),
              requiresCityPreview: cityOperations.length > 0, ...(singleCityPatch ? { cityPatch: singleCityPatch } : {}), expiresAt: Date.now() + Math.min(preview.expiresInMs, 600_000) });
          }
        }
      } catch (error) {
        if (!(error instanceof Error && error.message === "creator_confirmation_required")) noteAgent(method, payload, false, null);
        throw error;
      }
      if (method === "creator.project.create" || method.endsWith(".commit") || method === "creator.vehicle.define" || method === "creator.project.publish") window.dispatchEvent(new Event("__CREATOR_PROJECT_CHANGED__"));
      if (method === "creator.city.create" || method === "creator.city.create_from_world" || method === "creator.city.edit.commit") window.dispatchEvent(new Event("__CREATOR_CITY_CHANGED__"));
      noteAgent(method, payload, true, result);
      return result;
    }]));
    // This is a read-only Studio viewport, not a City runtime switch. It never
    // reads the legacy seed-keyed patch or writes to the active City.
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.view"] = async payload => {
      if (typeof payload.cityId !== "string" || typeof payload.revision !== "number" || !Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new Error("creator_request_invalid");
      return openCityView(payload.cityId, payload.revision);
    };
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.view.status"] = async payload => {
      const current = draftCityViewRef.current;
      if (!current || current.cityId !== payload.cityId || current.revision !== payload.revision) throw new Error("creator_capture_unavailable");
      return { cityId: current.cityId, revision: current.revision, status: draftViewStatusRef.current, failureCode: draftViewFailureRef.current ?? null,
        correlationId: draftDiagnosticsRef.current?.correlationId ?? null, diagnosticsAvailable: !draftDiagnosticsRef.current?.unavailable, mode: "read_only_preview" };
    };
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.capture"] = async payload => {
      const current = draftCityViewRef.current;
      const engine = draftEngineRef.current;
      if (!current || current.cityId !== payload.cityId || current.revision !== payload.revision || draftViewStatusRef.current !== "ready" || !engine) throw new Error("creator_capture_unavailable");
      const latest = await creatorRequest<unknown>("creator.city.read", { cityId: current.cityId });
      const validated = validateCityInstance(latest);
      if (!validated.ok || validated.value.revision !== current.revision) throw new Error("revision_conflict");
      if (draftCityViewRef.current !== current || draftEngineRef.current !== engine || draftViewStatusRef.current !== "ready") throw new Error("creator_capture_unavailable");
      const frame = engine.captureFrame();
      if (!frame.ok) throw new Error(frame.code);
      const camera = engine.inspectScene().camera as { position?: number[]; target?: number[] } | null;
      return { format: "image/jpeg", dataUrl: frame.dataUrl, width: frame.width, height: frame.height, downscaled: frame.downscaled,
        bytes: Math.ceil(frame.dataUrl.length * 0.75), cityId: current.cityId, revision: current.revision,
        camera: camera ? { position: camera.position, target: camera.target } : null, capturedAtMs: Date.now() };
    };
    for (const method of ["creator.city.anchor.list", "creator.city.anchor.upsert", "creator.city.anchor.remove",
      "creator.mount.list", "creator.mount.bind", "creator.mount.unbind", "creator.game.bind.preview"]) {
      (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)[method] = async payload => creatorRequest(method, payload);
    }
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.layout.read"] = async payload => {
      const current = draftCityViewRef.current;
      const engine = draftEngineRef.current;
      if (!current || current.cityId !== payload.cityId || current.revision !== payload.revision || draftViewStatusRef.current !== "ready" || !engine) throw new Error("creator_capture_unavailable");
      const latest = validateCityInstance(await creatorRequest<unknown>("creator.city.read", { cityId: current.cityId }));
      if (!latest.ok || latest.value.revision !== current.revision) throw new Error("revision_conflict");
      if (draftCityViewRef.current !== current || draftEngineRef.current !== engine || draftViewStatusRef.current !== "ready") throw new Error("creator_capture_unavailable");
      const view = engine.getCitySdkLayoutView();
      if (!view) throw new Error("creator_layout_not_ready");
      // 发布快照带锚点几何（v3）：否则 Creator 加的空域门离开运行时就定位不到位置。
      createCreatorLayoutSnapshot(view);
      const scoped = validateCityLayoutScope(createScopedCreatorLayoutSnapshot(view, current.cityId, current.revision), current);
      if (!scoped.ok) throw new Error("creator_layout_scope_invalid");
      return scoped.value;
    };
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.layout.save"] = async payload => {
      // Capture from the live, scoped renderer; callers cannot supply a snapshot.
      const current = draftCityViewRef.current;
      try {
        const snapshot = await (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.city.layout.read"](payload);
        // 先按整份快照存；若该 revision 已有快照而内容变了（典型：快照里还有 Creator 加的
        // 空域门，而渲染器只能重新产出路网投影），退回到「只合并几何」——保住锚点，只补位置。
        let result: unknown;
        try {
          result = await creatorRequest("creator.city.layout.store", { snapshot });
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code !== "creator_layout_revision_conflict") throw error;
          // 快照里的 anchors 才是权威（含 Creator 加的空域门），但渲染器只能捕获它自己
          // 投影出的那批锚点；因此这里提交**整张**几何表，由宿主按快照引用的 ref 过滤。
          const view = draftEngineRef.current?.getCitySdkLayoutView();
          if (!view) throw error;
          const geometry = [...view.geometry.entries()].slice(0, 512).map(([geometryRef, entry]) => ({
            geometryRef,
            positionMeters: { x: entry.positionMeters.x, y: entry.positionMeters.y, z: entry.positionMeters.z },
            ...(entry.activationRadiusMeters === undefined ? {} : { activationRadiusMeters: entry.activationRadiusMeters }),
            ...(entry.facingRadians === undefined ? {} : { facingRadians: entry.facingRadians }),
          }));
          result = await creatorRequest("creator.city.layout.geometry",
            { cityId: (payload as { cityId?: unknown }).cityId, baseRevision: (payload as { revision?: unknown }).revision, geometry });
          // 迁移产出的是**新 City revision**（历史快照不可变）：把草稿视图切到新版本，
          // 之后的保存/建项目/绑定都对着同一个版本。
          const migrated = result as { cityRevision?: unknown };
          if (current && typeof migrated.cityRevision === "number") {
            await openCityView(current.cityId, migrated.cityRevision);
          }
        }
        if (current) await recordCityDiagnostic(current, "layout_saved");
        window.dispatchEvent(new Event("__CREATOR_LAYOUT_CHANGED__"));
        return result;
      } catch (error) {
        if (current) await recordCityDiagnostic(current, "layout_save_failed", "layout_store_failed");
        throw error;
      }
    };
    // creator.scene.capture 在 WebView 本地完成（渲染器在这里，图像不出本机）。
    // 修订以库里的项目为准：视口 projectRef 在 vehicle.define 之后会停在旧修订，
    // 那不是 revision_conflict。库已经前进到别的修订时才拒绝。
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.scene.capture"] = async (payload: Record<string, unknown>) => {
      if (draftCityViewRef.current) throw new Error("creator_capture_unavailable");
      const engine = studioEngineRef.current;
      if (!engine) throw new Error("creator_capture_unavailable");
      const open = projectRef.current;
      const requestedId = typeof payload.projectId === "string" ? payload.projectId : open?.projectId;
      if (!open || !requestedId || open.projectId !== requestedId) throw new Error("creator_capture_requires_project");
      const document = await creatorRequest<Project>("creator.project.read", { projectId: requestedId });
      const decision = resolveSceneCaptureRevision({
        projectOpen: true,
        projectMatches: document.projectId === requestedId,
        requestedRevision: typeof payload.revision === "number" ? payload.revision : undefined,
        authoritativeRevision: document.revision,
        viewportRevision: open.revision,
      });
      if (!decision.ok) throw new Error(decision.code);
      if (decision.refreshViewport) applyRef.current(document, "preserve", open);
      // 帧按描述符给 capture 的 mailbox 预算（512 KiB）与 MCP 帧上限（350K 字符）
      // 逐档降级；不可用与超预算由 captureFrame 返回不同 code，不能混成一句。
      const frame = engine.captureFrame();
      if (!frame.ok) throw new Error(frame.code);
      const camera = engine.inspectScene().camera as { position?: number[]; target?: number[] } | null;
      const result = { format: "image/jpeg", dataUrl: frame.dataUrl, width: frame.width, height: frame.height, downscaled: frame.downscaled,
        bytes: Math.ceil(frame.dataUrl.length * 0.75), revision: decision.revision,
        camera: camera ? { position: camera.position, target: camera.target } : null, capturedAtMs: Date.now() };
      noteAgent("creator.scene.capture", payload, true, { revision: decision.revision });
      return result;
    };
    // creator.scene.validate 由 Studio 合并三方结果（设计 §5.3）：Rust structure_check
    // 提供结构/预算/资产字节事实，SDK 提供 game/scene/mount 语义诊断，这里合并、
    // 去重（code+objectId）、排序并截断。MCP 工具表不暴露 structure_check。
    (handlers as Record<string, (payload: Record<string, unknown>) => Promise<unknown>>)["creator.scene.validate"] = async (payload: Record<string, unknown>) => {
      const profile = payload.validationProfile;
      if (profile !== undefined && profile !== "static") throw new Error("creator_validation_profile_unsupported");
      const document = await creatorRequest<Project>("creator.project.read", { projectId: String(payload.projectId ?? "") });
      if (typeof payload.revision === "number" && payload.revision !== document.revision) throw new Error("revision_conflict");
      const structure = await creatorRequest<{ ok: boolean; truncated: boolean; items: Array<Record<string, unknown>>; unchecked: unknown[] }>(
        "creator.scene.structure_check", { projectId: document.projectId, revision: document.revision });
      const sdkItems: Array<Record<string, unknown>> = [];
      const pushSdk = (diagnostics: readonly { code: string; severity: "error" | "warning"; path: string; objectId?: string; message: string }[]) => {
        for (const item of diagnostics) {
          sdkItems.push({ code: item.code, severity: item.severity, source: "static-schema",
            objectId: item.objectId ?? null, message: item.message });
        }
      };
      pushSdk(validateMiniGamePack(document.game).diagnostics);
      if (document.scene) pushSdk(validateSceneDraft(document.scene).diagnostics);
      const layout = document.cityLayout && !Array.isArray(document.cityLayout) ? (document.cityLayout as { layout?: unknown }).layout : undefined;
      for (const mount of document.mounts ?? []) {
        if (!layout) { sdkItems.push({ code: "creator_layout_not_bound", severity: "error", source: "static-schema", objectId: mount.mountId ?? null, message: "项目未绑定 City 布局，挂载无法校验。" }); continue; }
        pushSdk(validateMount({ layout, game: document.game, mount }).diagnostics);
      }
      // 合并去重（code+objectId 同一违例只报一次），error 优先、其余稳定排序，超限截断。
      const merged = new Map<string, Record<string, unknown>>();
      for (const entry of [...structure.items, ...sdkItems]) {
        const key = `${entry.code}|${entry.objectId ?? ""}`;
        if (!merged.has(key)) merged.set(key, entry);
      }
      const MAX_ITEMS = 100;
      const ordered = [...merged.values()].sort((a, b) => (a.severity === b.severity ? String(a.code).localeCompare(String(b.code)) : a.severity === "error" ? -1 : 1));
      const truncated = structure.truncated || ordered.length > MAX_ITEMS;
      const items = ordered.slice(0, MAX_ITEMS);
      const ok = !truncated && !items.some(entry => entry.severity === "error");
      return { projectId: document.projectId, revision: document.revision, ok, truncated, items, unchecked: structure.unchecked };
    };
    // 重启重放（O4）：从插件私有 state 恢复上一会话的活动卡；读失败保持空态。
    void restoreAgentActivity();
    const disconnectHostCalls = connectHostCalls(handlers);
    const disconnectHealth = observeHealth();
    return () => { disconnectHostCalls(); disconnectHealth(); };
  }, []);
}
