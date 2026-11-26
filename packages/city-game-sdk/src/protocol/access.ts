import type { CodeGameManifestV2 } from "./manifestV2";
import {
  capabilityForPermissionV2,
  type GamePermissionV2,
  type WorldCapabilityV2,
} from "./permissions";
import { deepFreeze } from "./freeze";

export type GameAccessV1 = Readonly<{
  availableCapabilities: readonly WorldCapabilityV2[];
  requestedPermissions: readonly GamePermissionV2[];
  grantedPermissions: readonly GamePermissionV2[];
}>;

/** PlayerScopeV1 remains City-owned. Runtime adapters can supply its type as
 * the generic argument without this package copying that shared DTO. */
export type InvokeContextV1<PlayerScopeV1 = never> = Readonly<{
  navigationMode?: "surface" | "volume";
  runId: string;
  playerScope?: PlayerScopeV1;
}>;

export type HostGrantStatusV1 = "active" | "revoked" | "expired";

export type HostGrantV1<PlayerScopeV1 = never> = Readonly<{
  installationId: string;
  runId: string;
  playerScope?: PlayerScopeV1;
  grantedPermissions: readonly GamePermissionV2[];
  status: HostGrantStatusV1;
}>;

export type GameInvocationDenialV1 =
  | "run-invalid"
  | "permission-not-requested"
  | "permission-not-granted"
  | "capability-unavailable"
  | "navigation-mode-required";

export type GameInvocationDecisionV1 = Readonly<
  | { ok: true }
  | {
      ok: false;
      reason: GameInvocationDenialV1;
      permission: GamePermissionV2;
      requiredCapability?: WorldCapabilityV2;
    }
>;

export function createGameAccessV1<PlayerScopeV1 = never>(
  manifest: CodeGameManifestV2,
  availableCapabilities: readonly WorldCapabilityV2[],
  grant: HostGrantV1<PlayerScopeV1>,
): GameAccessV1 {
  return deepFreeze({
    availableCapabilities: [...availableCapabilities],
    requestedPermissions: [...manifest.permissions],
    grantedPermissions: [...grant.grantedPermissions],
  });
}

export function evaluateGameInvocation<PlayerScopeV1 = never>(
  permission: GamePermissionV2,
  context: InvokeContextV1<PlayerScopeV1>,
  access: GameAccessV1,
  grant: HostGrantV1<PlayerScopeV1>,
): GameInvocationDecisionV1 {
  const deny = (
    reason: GameInvocationDenialV1,
    requiredCapability?: WorldCapabilityV2,
  ): GameInvocationDecisionV1 =>
    Object.freeze({
      ok: false as const,
      reason,
      permission,
      ...(requiredCapability !== undefined ? { requiredCapability } : {}),
    });

  if (grant.status !== "active" || grant.runId !== context.runId) return deny("run-invalid");
  if (grant.playerScope !== undefined || context.playerScope !== undefined) {
    if (grant.playerScope === undefined || context.playerScope === undefined) return deny("run-invalid");
    if (!samePlayerScope(grant.playerScope, context.playerScope)) return deny("run-invalid");
  }
  if (!access.requestedPermissions.includes(permission)) return deny("permission-not-requested");
  if (!access.grantedPermissions.includes(permission) || !grant.grantedPermissions.includes(permission)) {
    return deny("permission-not-granted");
  }

  const mapped = capabilityForPermissionV2(permission);
  if (mapped === null) return Object.freeze({ ok: true as const });
  if (mapped === "navigation") {
    if (context.navigationMode === undefined) return deny("navigation-mode-required");
    const requiredCapability = context.navigationMode === "surface" ? "navigation.surface" : "navigation.volume";
    return access.availableCapabilities.includes(requiredCapability)
      ? Object.freeze({ ok: true as const })
      : deny("capability-unavailable", requiredCapability);
  }
  return access.availableCapabilities.includes(mapped)
    ? Object.freeze({ ok: true as const })
    : deny("capability-unavailable", mapped);
}

export function canInvoke<PlayerScopeV1 = never>(
  permission: GamePermissionV2,
  context: InvokeContextV1<PlayerScopeV1>,
  access: GameAccessV1,
  grant: HostGrantV1<PlayerScopeV1>,
): boolean {
  return evaluateGameInvocation(permission, context, access, grant).ok;
}

function samePlayerScope(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const a = left as { playerId?: unknown; kind?: unknown };
  const b = right as { playerId?: unknown; kind?: unknown };
  return a.playerId === b.playerId && a.kind === b.kind;
}
