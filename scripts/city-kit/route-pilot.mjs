// Polyline-following pilot for same-kernel route runs (button-style controls, pure pursuit).
// Every tick is independently re-validated; the caller decides what a result means.
export function makeRoutePilot(kit, key) {
  /** Drive `path` (XZ polyline) from its first point; returns ok / blocked@s:reason / start:… / timeout. */
  return function drivePath(regions, path, { regionId, y, until, lookahead = 4, maxTicks = 6000, collision } = {}) {
    const lengths = [0];
    for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    const total = until ?? lengths[lengths.length - 1];
    const at = (s) => {
      let i = 1; while (i < path.length - 1 && lengths[i] < s) i++;
      const a = path[i - 1], b = path[i]; const t = Math.max(0, Math.min(1, (s - lengths[i - 1]) / ((lengths[i] - lengths[i - 1]) || 1)));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    };
    const progress = kit.polylineProgress(path);
    const p0 = path[0]; const p1 = at(1);
    const heading = Math.atan2(p1.z - p0.z, p1.x - p0.x);
    const env = new kit.SurfaceDrivingEnvironment(regions, undefined, undefined, collision);
    const kernel = new kit.DrivingKernel(env, key);
    const region = regionId ?? (() => { const c = regions.classify(p0.x, p0.z, "ground"); return c.status === "drivable" ? c.regionId : null; })();
    if (!region) return { result: "start:no-surface", s: 0, maxY: 0, layers: [] };
    const placed = env.place(p0.x, p0.z, heading, region, y);
    if (!placed) return { result: "start:footprint", s: 0, maxY: 0, layers: [] };
    let state = { ...kit.initialDrivingState(p0.x, p0.z, heading, region), ...placed };
    const validator = new kit.SurfaceWorldValidator(regions, progress, undefined, undefined, collision);
    if (validator.validateStart(state) !== "valid") return { result: "start:invalid", s: 0, maxY: state.y, layers: [] };
    let maxY = state.y; const layers = new Set();
    for (let tick = 0; tick < maxTicks; tick++) {
      const s = progress(state);
      if (s >= total) return { result: "ok", s, maxY, layers: [...layers] };
      const target = at(Math.min(lengths[lengths.length - 1], s + lookahead));
      const want = Math.atan2(target.z - state.z, target.x - state.x);
      const err = Math.atan2(Math.sin(want - state.heading), Math.cos(want - state.heading));
      const step = kernel.step(state, { forward: true, backward: false, left: err < -0.02, right: err > 0.02 });
      const verdict = validator.validate(state, step);
      if (verdict !== "valid") return { result: `invalid@${s.toFixed(1)}:${verdict}`, s, maxY, layers: [...layers] };
      if (step.motion.blocked) return { result: `blocked@${s.toFixed(1)}:${step.motion.reason}`, s, maxY, layers: [...layers] };
      state = step.state; maxY = Math.max(maxY, state.y);
      const support = kit.footprintSupport(regions, state, state.surfaceId);
      if (support.ok) layers.add(support.layerId);
    }
    return { result: "timeout", s: progress(state), maxY, layers: [...layers] };
  };
}
