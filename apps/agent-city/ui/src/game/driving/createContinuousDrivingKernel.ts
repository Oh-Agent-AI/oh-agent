/** Version-calibrated C kernel entry for B's per-case audit factory. */
import {DRIVING_PHYSICS_VERSION} from "../DrivingSimulation";
import {DrivingKernel} from "./DrivingKernel";
import {DRIVING_COLLISION_VERSION} from "./DrivingCollision";
import {CONTINUOUS_DRIVING_QUERY_VERSION,type ContinuousDrivingEnvironment} from "./ContinuousDrivingEnvironment";
export function createContinuousDrivingKernel(environment:ContinuousDrivingEnvironment,
  identity:Readonly<{worldRevision:string;vehicleConfigHash:string;kernelBuildId:string}>):DrivingKernel {
  if(!identity.worldRevision||environment.worldRevision!==identity.worldRevision||!identity.vehicleConfigHash||!identity.kernelBuildId)throw new Error("invalid-continuous-kernel-identity");
  return new DrivingKernel(environment,{baseSnapshotHash:identity.worldRevision,vehicleConfigHash:identity.vehicleConfigHash,kernelBuildId:identity.kernelBuildId,
    physicsVersion:DRIVING_PHYSICS_VERSION,collisionVersion:DRIVING_COLLISION_VERSION,queryVersion:CONTINUOUS_DRIVING_QUERY_VERSION});
}
