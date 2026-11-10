import { MECHA_V15_REMOTE_HOST } from "./MechaV15RemoteHostAdapter";
import { DREAM_CITY_REMOTE_HOST } from "./city/DreamCityRemoteHostAdapter";
import type { RemoteHostAdapterFactory } from "./RemoteHostAdapterRegistry";

/** Trusted desktop host adapters. Runtime plugin declarations cannot extend this list. */
export const REMOTE_HOST_ADAPTERS: readonly RemoteHostAdapterFactory[] = [MECHA_V15_REMOTE_HOST, DREAM_CITY_REMOTE_HOST];
