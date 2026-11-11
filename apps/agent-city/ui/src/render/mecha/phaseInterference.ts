import * as THREE from "three";

/** A bounded standing-wave interference volume for the phase creature. */
export function createPhaseInterference() {
  const count = 1800;
  const positions = new Float32Array(count * 3);
  const parameters = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const u = (i + .5) / count;
    const angle = i * 2.399963229728653;
    const y = (u - .5) * 6.2;
    const radius = 2.65 * Math.sqrt(Math.max(0, 1 - (y / 3.5) ** 2));
    positions.set([radius * Math.cos(angle), y, radius * Math.sin(angle)], i * 3);
    parameters.set([angle, y], i * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("waveCoord", new THREE.BufferAttribute(parameters, 2));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  const material = new THREE.ShaderMaterial({
    uniforms: { phase: { value: 0 } },
    vertexShader: `attribute vec2 waveCoord; uniform float phase; varying float intensity; varying float fade;
      void main() {
        float a = sin(waveCoord.y * 3.1 - phase);
        float b = sin(waveCoord.y * 3.1 + waveCoord.x * 2.0 + phase);
        intensity = pow(abs((a + b) * .5), 2.0);
        vec3 p = position * (1.0 + .06 * sin(waveCoord.y * 2.0 + phase));
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        fade = projectionMatrix[2][3] == 0.0 ? 1.0 : clamp(24.0 / max(1.0, -view.z), .12, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = max(1.0, (2.0 + 3.0 * intensity) * fade);
      }`,
    fragmentShader: `varying float intensity; varying float fade;
      void main() { float r = length(gl_PointCoord - vec2(.5)); if (r > .5) discard;
        vec3 color = mix(vec3(.35,.18,.85), vec3(.9,.8,1.0), intensity);
        gl_FragColor = vec4(color, intensity * (1.0 - r * 2.0) * .7 * fade); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = "monster-fx-phase-interference";
  points.raycast = () => {};
  return {
    root: points,
    update(elapsed: number, reducedMotion: boolean) { if (!reducedMotion) material.uniforms.phase!.value = elapsed * 0.8; },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}
