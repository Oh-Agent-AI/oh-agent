// Compile-time regression checks; no runtime registration or executable skills.
import type { EncounterContent, MonsterPlannerPolicyId, MonsterSkillId, MonsterSpeciesId, PlannedMonsterDefinition } from "./contracts";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type CheckSporeSkill = Assert<Equal<PlannedMonsterDefinition<"spore_leaper">["signatureSkill"]["id"], "spore_leap">>;
type CheckLegacyPolicy = Assert<Equal<MonsterPlannerPolicyId, "stationary_smash" | "cadence_ssw" | "raid_ssw" | "siege">>;
// @ts-expect-error Unknown species are not registered.
type InvalidSpecies = Assert<"arbitrary" extends MonsterSpeciesId ? true : false>;
// @ts-expect-error Unknown skills are not registered.
type InvalidSkill = Assert<"arbitrary" extends MonsterSkillId ? true : false>;
// @ts-expect-error An assignment cannot silently claim another content version.
type InvalidVersion = Assert<2 extends EncounterContent["contentVersion"] ? true : false>;
// @ts-expect-error A different species' skill cannot be bound to the spore definition.
type InvalidSporeSkill = Assert<"ring_pierce" extends PlannedMonsterDefinition<"spore_leaper">["signatureSkill"]["id"] ? true : false>;

import type { MonsterSkillHandler, PreparedSkillIntent, SkillData, SkillProjection, SkillResolution } from "./skillContracts";
type ExampleState = { boss: { hp: number }; cells: { x: number; y: number }[] };
type ExampleIntentData = { radius: number };
type ExampleProjectionData = { count: number };
type ExampleChange = { readonly kind: "damage"; readonly amount: number };
type ExampleEvent = { readonly kind: "hit"; readonly amount: number };
type ExampleHandler = MonsterSkillHandler<"spore_leap", ExampleState, ExampleIntentData, ExampleProjectionData, ExampleChange, ExampleEvent>;
type ExpectedIntent = PreparedSkillIntent<"spore_leap", ExampleIntentData>;
type CheckHandlerIntent = Assert<Equal<Parameters<ExampleHandler["reproject"]>[1], ExpectedIntent>>;
type CheckResolveProjection = Assert<Equal<Parameters<ExampleHandler["resolve"]>[2], SkillProjection<ExampleProjectionData>>>;
type CheckResolveResult = Assert<Equal<ReturnType<ExampleHandler["resolve"]>, SkillResolution<ExampleChange, ExampleEvent>>>;
// @ts-expect-error Unregistered skill IDs cannot define a handler.
type InvalidHandler = MonsterSkillHandler<"arbitrary", ExampleState, null, null, null, null>;
// @ts-expect-error Serializable intent data cannot contain a function.
type NonSerializable = MonsterSkillHandler<"spore_leap", ExampleState, { fn: () => void }, null, null, null>;
// @ts-expect-error A projection does not replace the bound target.
type ProjectionHasNoTarget = Assert<"target" extends keyof SkillProjection<null> ? true : false>;
// @ts-expect-error A void resolution cannot contain state changes.
type InvalidVoidChanges = Assert<{ status: "void"; reason: string; changes: [1]; events: [] } extends SkillResolution<SkillData, SkillData> ? true : false>;
function verifyReadonly(state: Parameters<ExampleHandler["prepare"]>[0], intent: ExpectedIntent) {
  // @ts-expect-error Rule state is read-only to handlers.
  state.boss.hp = 0;
  // @ts-expect-error Nested arrays and cells are read-only.
  state.cells[0].x = 1;
  // @ts-expect-error Reprojection must not mutate the declared binding.
  intent.target = { kind: "none" };
  // @ts-expect-error Nested intent data is also read-only.
  intent.data.radius = 1;
}
