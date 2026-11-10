import { defaultKitModel, entityChangedFromBuilding, parseKitModel, type KitModel } from "../engine/sessionKitConstruction";
import { ENTITY_CHANGED_EVENT } from "../engine/entityEvents";
import { INHERITANCE_KIT_VERSION, normalizeInheritance, resolveInheritance } from "../engine/sessionKitInheritance";
import { compliantCatalogIds, deriveBuildingSlot, validateBuildingCompliance, validateDetailRegression } from "../engine/sessionKitCompliance";
import { validateDesignCoherence } from "../engine/sessionKitDesign";
import {
  cityBuildingObjectClient,
  readBuildingOverrides,
  stableAssetRefsForProjection,
  type CityProjectionV1,
} from "./provider";
import { commitCityBuildingObject, readCityBuildingObject } from "./cityBuildingObjects";

function round4(value: number): number { return Math.round(value * 10_000) / 10_000; }
function round3(value: number): number { return Math.round(value * 1_000) / 1_000; }

function geometricSummary(model: KitModel) {
  const bounds = model.parts.map((part) => {
    const rotated = !!part.rot?.some((value) => Math.abs(value) > 1e-6);
    const halfX = rotated ? Math.max(part.size[0], part.size[2]) / 2 : part.size[0] / 2;
    const halfZ = rotated ? Math.max(part.size[0], part.size[2]) / 2 : part.size[2] / 2;
    return { min: [part.at[0] - halfX, part.at[1], part.at[2] - halfZ],
      max: [part.at[0] + halfX, part.at[1] + part.size[1], part.at[2] + halfZ] };
  });
  const min = [0, 1, 2].map((axis) => Math.min(...bounds.map((box) => box.min[axis]!)));
  const max = [0, 1, 2].map((axis) => Math.max(...bounds.map((box) => box.max[axis]!)));
  return { part_count: model.parts.length, height: round4(max[1]! - min[1]!),
    bbox: { min: min.map(round4), max: max.map(round4) } };
}

function projectionMeta(session: CityProjectionV1["sessions"][number], tokens: number, summary: ReturnType<typeof geometricSummary>, kitStatus: string) {
  const derived = deriveBuildingSlot(tokens);
  const slot = { height_class: derived.heightClass, footprint: { half_x: round3(derived.halfX), half_z: round3(derived.halfZ) },
    max_height: round3(derived.maxHeight), budget_cap: round3(derived.budgetCap),
    story_height: { min: derived.storyHeightMin, max: derived.storyHeightMax },
    required_part_roles: ["door", "window"], source: "derived" };
  return { asset_ref: session.asset_ref, session_id: session.id, harness: session.harness, height: summary.height,
    lot: slot, compliant_catalog: compliantCatalogIds(derived),
    parcel: { state: "unavailable", reason: "city_layout_not_in_building_store" }, kit_status: kitStatus,
    screenshot: { state: "unavailable", reason: "optional_vision_attachment_not_in_mvp" } };
}

type CityBuildingSession = CityProjectionV1["sessions"][number] & { id: string; asset_ref: string };

function findSession(projection: CityProjectionV1 | null, requested: unknown): CityBuildingSession {
  if (typeof requested !== "string" || !projection || projection.source !== "local") throw new Error("session_unavailable");
  const session = projection.sessions.find((row) => row.id === requested || row.asset_ref === requested);
  if (!session || typeof session.id !== "string" || !/^sr_[0-9a-f]{32}$/.test(session.id)
      || typeof session.asset_ref !== "string" || !/^ca_[0-9a-f]{32}$/.test(session.asset_ref)
      || !Number.isSafeInteger(session.tokens.total)) throw new Error("session_unavailable");
  return session as CityBuildingSession;
}

/** City-local building operations over generic objects and bounded host calls. */
export function createCityBuildingCallHandlers(input: {
  projection: () => CityProjectionV1 | null;
}) {
  async function readOverride(session: CityBuildingSession, stableRefs: ReadonlyMap<string, string>) {
    const stableRef = stableRefs.get(session.asset_ref);
    if (!stableRef) throw new Error("session_unavailable");
    let objectState: Awaited<ReturnType<typeof readCityBuildingObject>> = null;
    try {
      const client = await cityBuildingObjectClient();
      objectState = await readCityBuildingObject(client, stableRef);
    } catch { /* the typed legacy export below remains available during object-store recovery */ }
    if (objectState?.authority === "generic-object") {
      const inherited = objectState.inheritance ? resolveInheritance(defaultKitModel(session.tokens.total), objectState.inheritance) : objectState.model;
      const isReset = objectState.inheritance?.reset === true;
      const override = inherited && !isReset ? { model: inherited, revision: objectState.domainRevision, source: "generic-object" } : undefined;
      return { override, domainRevision: objectState.domainRevision, inheritance: objectState.inheritance ?? undefined };
    }
    const legacy = await readBuildingOverrides([session.asset_ref], stableRefs,
      new Map([[session.asset_ref, session.tokens.total]]));
    const state = legacy.objectStates.find((row) => row.asset_ref === session.asset_ref)?.state;
    const override = legacy.overrides.find((row) => row.asset_ref === session.asset_ref)
      ?? (objectState?.model ? { model: objectState.model, revision: objectState.domainRevision, source: "generic-object" } : undefined);
    return { override, domainRevision: state?.domainRevision ?? objectState?.domainRevision ?? override?.revision ?? 0,
      inheritance: state?.inheritance ?? objectState?.inheritance ?? undefined };
  }

  function emitEdit(session: CityBuildingSession, action: "preview" | "reject", revision: number,
    model?: KitModel, error?: { rule: string }) {
    const detail = { type: "CityEntityChanged", entity_kind: "building", entity_id: session.asset_ref,
      asset_ref: session.asset_ref, session_id: session.id, action, kind: action, revision,
      event_id: `be_local_${crypto.randomUUID()}`, source: "plugin-call", ...(model ? { model } : {}),
      ...(error ? { error } : {}) };
    window.dispatchEvent(new CustomEvent(ENTITY_CHANGED_EVENT, { detail }));
  }

  function resolveProposal(session: CityBuildingSession, inheritance: unknown,
    current: Awaited<ReturnType<typeof readOverride>>) {
    const defaultKit = defaultKitModel(session.tokens.total);
    const currentModel = parseKitModel(current.override?.model) ?? defaultKit;
    const proposed = resolveInheritance(defaultKit, inheritance);
    const slot = deriveBuildingSlot(session.tokens.total);
    const complianceIssue = validateBuildingCompliance(proposed, slot);
    if (complianceIssue) return { current, currentModel, issue: complianceIssue, model: proposed, warnings: [] as unknown[] };
    const detailIssue = validateDetailRegression(currentModel, proposed, slot);
    if (detailIssue) return { current, currentModel, issue: detailIssue, model: proposed, warnings: [] as unknown[] };
    const design = validateDesignCoherence(currentModel, proposed, inheritance);
    if (design.issue) return { current, currentModel, issue: design.issue, model: proposed, warnings: [] as unknown[] };
    return { current, currentModel, issue: null, model: proposed, warnings: design.warnings };
  }

  function validationResult(issue: { rule: string; message: string; suggested_fix: string; parts?: string[]; compliant_models?: string[] }, revision: number) {
    const error = { kind: "validation", rule: issue.rule, parts: issue.parts ?? [], message: issue.message,
      suggested_fix: issue.suggested_fix, ...(issue.compliant_models?.length ? { compliant_models: issue.compliant_models } : {}) };
    if (["invalid_model", "detail_regression", "disconnected_part", "massing_drift"].includes(issue.rule)) {
      // The City edit reducer uses this event to flash hard validation failures.
      // Session identity is attached by the caller before dispatch.
    }
    return { ok: false, error, persisted: false, revision };
  }

  async function preview(payload: Record<string, unknown>) {
    if (Object.keys(payload).some((key) => !["session_id", "inheritance"].includes(key))) throw new Error("invalid_payload");
    const projection = input.projection();
    const session = findSession(projection, payload.session_id);
    const stableRefs = stableAssetRefsForProjection(projection!);
    const stableRef = stableRefs.get(session.asset_ref);
    if (!stableRef) throw new Error("session_unavailable");
    const current = await readOverride(session, stableRefs);
    const revision = current.domainRevision;
    let model: KitModel;
    let warnings: unknown[] = [];
    try {
      model = resolveInheritance(defaultKitModel(session.tokens.total), payload.inheritance);
      if (!(payload.inheritance && typeof payload.inheritance === "object" && !Array.isArray(payload.inheritance)
          && (payload.inheritance as Record<string, unknown>).reset === true)) {
        const evaluated = resolveProposal(session, payload.inheritance, current);
        if (evaluated.issue) {
          if (["invalid_model", "detail_regression", "disconnected_part", "massing_drift"].includes(evaluated.issue.rule)) {
            emitEdit(session, "reject", revision, undefined, { rule: evaluated.issue.rule });
          }
          return validationResult(evaluated.issue, revision);
        }
        model = evaluated.model;
        warnings = evaluated.warnings;
      }
    } catch (error) {
      const issue = error && typeof error === "object" && "issue" in error
        ? (error as { issue: { rule: string; message: string; suggested_fix: string } }).issue
        : { rule: "invalid_inheritance", message: "inheritance document is invalid", suggested_fix: "send a valid session-kit inheritance document" };
      emitEdit(session, "reject", revision, undefined, { rule: issue.rule });
      return validationResult(issue, revision);
    }
    emitEdit(session, "preview", revision, model);
    const summary = geometricSummary(model);
    return { ok: true, error: null, persisted: false, revision, kit_version: "session-kit/inheritance/v1",
      inheritance: payload.inheritance, model, summary, warnings,
      observe: { text: `preview model, ${summary.part_count} parts, height ${summary.height}, revision ${revision}`, summary },
      projection: projectionMeta(session, session.tokens.total, summary, "current") };
  }

  async function persist(payload: Record<string, unknown>, reset: boolean) {
    const allowed = reset ? ["session_id", "expected_revision"] : ["session_id", "inheritance", "expected_revision"];
    if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error("invalid_payload");
    if (!Number.isSafeInteger(payload.expected_revision) || Number(payload.expected_revision) < 0) throw new Error("invalid_payload");
    const projection = input.projection();
    const session = findSession(projection, payload.session_id);
    const stableRefs = stableAssetRefsForProjection(projection!);
    const stableRef = stableRefs.get(session.asset_ref);
    if (!stableRef) throw new Error("session_unavailable");
    const current = await readOverride(session, stableRefs);
    const expected = Number(payload.expected_revision);
    if (current.domainRevision !== expected) return { ok: false, persisted: false, revision: current.domainRevision,
      error: { kind: "conflict", rule: "revision_conflict", parts: [],
        message: `expected_revision does not match current revision ${current.domainRevision}`,
        suggested_fix: "call get_building and retry with the returned revision" } };
    const defaultKit = defaultKitModel(session.tokens.total);
    let inheritance: Record<string, unknown> | null = null;
    let model: KitModel | null = null;
    let warnings: unknown[] = [];
    if (!reset) {
      try {
        const normalized = normalizeInheritance(payload.inheritance);
        if (normalized.reset === true) inheritance = null;
        else inheritance = normalized as unknown as Record<string, unknown>;
        if (inheritance !== null) {
          const evaluated = resolveProposal(session, inheritance, current);
          if (evaluated.issue) {
            if (["invalid_model", "detail_regression", "disconnected_part", "massing_drift"].includes(evaluated.issue.rule)) {
              emitEdit(session, "reject", current.domainRevision, undefined, { rule: evaluated.issue.rule });
            }
            return validationResult(evaluated.issue, current.domainRevision);
          }
          model = evaluated.model;
          warnings = evaluated.warnings;
        }
      } catch (error) {
        const issue = error && typeof error === "object" && "issue" in error
          ? (error as { issue: { rule: string; message: string; suggested_fix: string } }).issue
          : { rule: "invalid_inheritance", message: "inheritance document is invalid", suggested_fix: "send a valid session-kit inheritance document" };
        return validationResult(issue, current.domainRevision);
      }
    }
    const client = await cityBuildingObjectClient();
    let committed: Awaited<ReturnType<typeof commitCityBuildingObject>>;
    try {
      committed = await commitCityBuildingObject(client, stableRef, expected, model,
        `city-kit-${crypto.randomUUID()}`, Date.now(), inheritance);
    } catch (error) {
      if (error instanceof Error && error.message === "revision_conflict") {
        const latest = await readCityBuildingObject(client, stableRef);
        const revision = latest?.domainRevision ?? current.domainRevision;
        return { ok: false, persisted: false, revision, error: { kind: "conflict", rule: "revision_conflict", parts: [],
          message: `expected_revision does not match current revision ${revision}`,
          suggested_fix: "call get_building and retry with the returned revision" } };
      }
      throw error;
    }
    const kind = model ? "set" : "reset";
    const buildEventId = `be_generic_${session.asset_ref}_${committed.objectRevision}`;
    const event = entityChangedFromBuilding({ asset_ref: session.asset_ref, session_id: session.id,
      event_id: buildEventId, revision: committed.domainRevision, kind, source: "generic-object", model });
    window.dispatchEvent(new CustomEvent(ENTITY_CHANGED_EVENT, { detail: event }));
    const effectiveModel = model ?? defaultKit;
    const summary = geometricSummary(effectiveModel);
    return { ok: true, error: null, persisted: true, revision: committed.domainRevision,
      build_event_id: buildEventId, kit_version: inheritance ? INHERITANCE_KIT_VERSION : effectiveModel.kit_version,
      model: effectiveModel, summary, warnings,
      observe: { text: `${kind} model, ${summary.part_count} parts, height ${summary.height}, revision ${committed.domainRevision}`, summary },
      projection: projectionMeta(session, session.tokens.total, summary, "current") };
  }

  return {
    "city.building.get": async (payload: Record<string, unknown>) => {
      if (Object.keys(payload).some((key) => key !== "session_id")) throw new Error("invalid_payload");
      const projection = input.projection();
      const session = findSession(projection, payload.session_id);
      const stableRefs = stableAssetRefsForProjection(projection!);
      const stableRef = stableRefs.get(session.asset_ref);
      if (!stableRef) throw new Error("session_unavailable");
      const { override, inheritance } = await readOverride(session, stableRefs);
      const model = parseKitModel(override?.model) ?? defaultKitModel(session.tokens.total);
      const summary = geometricSummary(model);
      const source = override ? "override" : "default";
      const revision = override?.revision ?? 0;
      const status = "current";
      const result: Record<string, unknown> = {
        ok: true, error: null, source, revision, kit_version: inheritance ? INHERITANCE_KIT_VERSION : model.kit_version, model, summary,
        observe: { text: `${source} model, ${summary.part_count} parts, height ${summary.height}, revision ${revision}`, summary },
        projection: projectionMeta(session, session.tokens.total, summary, status),
      };
      if (inheritance) result.inheritance = inheritance;
      return result;
    },
    "city.building.preview": preview,
    "city.building.set": (payload: Record<string, unknown>) => persist(payload, false),
    "city.building.reset": (payload: Record<string, unknown>) => persist(payload, true),
  };
}
