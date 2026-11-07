import { useConnectedAssault } from "../render/mecha/connectedAssaultMode";
import { resolveMechaMode, type MechaMode, type ReleaseChoice, type RemoteStatus, type StatusSpecies } from "./mecha/mode";

export type MechaRuntimeSelection = {
  remoteStatus: RemoteStatus;
  releaseChoice: ReleaseChoice;
  releaseStatus: StatusSpecies | null;
  encounterActive: boolean;
};

/** Browser/build boundary: collect ambient flags once, then delegate all routing to the pure resolver. */
export function readMechaRuntime(selection: MechaRuntimeSelection): {
  mode: MechaMode;
  connectedAssault: boolean;
  assaultSequenceTrial: boolean;
} {
  const query = new URLSearchParams(location.search);
  const debug = import.meta.env.MODE === "debug";
  const ambient = window as Window & {
    __AV_V15_PROBE__?: boolean;
    __AV_V15_LOCAL_TEST__?: boolean;
    __CITY_ISOLATION_FIXTURE__?: boolean;
    __AV_PLUGIN_INSTANCE__?: string;
  };
  const nativeProbe = debug && Boolean(ambient.__CITY_ISOLATION_FIXTURE__) && ambient.__AV_V15_PROBE__ === true;
  const localTest = debug && Boolean(ambient.__AV_PLUGIN_INSTANCE__) && ambient.__AV_V15_LOCAL_TEST__ === true;
  const debugFixture = debug && !ambient.__AV_PLUGIN_INSTANCE__ && query.get("fixtureSessions") === "30";

  return {
    mode: resolveMechaMode({
      dev: import.meta.env.DEV,
      prod: import.meta.env.PROD,
      debug,
      query,
      remoteStatus: selection.remoteStatus,
      nativeProbe,
      localTest,
      debugFixture,
      releaseChoice: selection.releaseChoice,
      releaseStatus: selection.releaseStatus,
      encounterActive: selection.encounterActive,
    }),
    connectedAssault: useConnectedAssault(import.meta.env.DEV, location.search),
    assaultSequenceTrial: import.meta.env.DEV && query.get("assaultTrial") === "1" && query.get("assaultSequence") === "1",
  };
}
