import * as THREE from "three";

export type StatusAuraStatus = Readonly<{ target: string; source: string; kind: "poison" | "burn" | "freeze" | "stun" }>;

type Aura = { group: THREE.Group; objects: THREE.Mesh[]; phase: number };
const colors: Record<StatusAuraStatus["kind"], string> = { poison: "#8bd865", burn: "#ff804d", freeze: "#55bddd", stun: "#f5d967" };

/** Small bounded, entity-attached status visuals. The host calls sync from its
 * authoritative projection each frame, so movement, death and replay converge. */
export class StatusAuraLayer {
  private readonly active = new Map<string, Aura>();
  private elapsed = 0;

  get size(): number { return this.active.size; }

  sync(actors: ReadonlyMap<string, THREE.Object3D>, statuses: readonly StatusAuraStatus[], dt: number, reducedMotion: boolean): void {
    this.elapsed += Math.max(0, Number.isFinite(dt) ? dt : 0);
    const live = new Set<string>();
    for (const status of statuses) {
      const actor = actors.get(status.target);
      if (!actor) continue;
      const key = `${status.target}:${status.source}:${status.kind}`;
      live.add(key);
      let aura = this.active.get(key);
      if (!aura) { aura = this.create(status.kind); actor.add(aura.group); this.active.set(key, aura); }
      if (aura.group.parent !== actor) actor.add(aura.group);
      aura.phase = (aura.phase + Math.max(0, dt)) % (Math.PI * 2);
      const pulse = reducedMotion ? 0 : Math.sin(aura.phase * 2) * 0.06;
      aura.group.scale.setScalar(1 + pulse);
      aura.group.rotation.y = reducedMotion ? 0 : aura.phase * 0.24;
    }
    for (const [key, aura] of this.active) if (!live.has(key)) this.remove(key, aura);
  }

  dispose(): void { for (const [key, aura] of this.active) this.remove(key, aura); }

  private create(kind: StatusAuraStatus["kind"]): Aura {
    const group = new THREE.Group(); group.name = `status-aura:${kind}`; group.position.y = 5.2;
    const color = colors[kind], objects: THREE.Mesh[] = [];
    const add = (geometry: THREE.BufferGeometry, y: number, scale = 1, wireframe = false) => {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: kind === "freeze" ? .13 : kind === "stun" ? .72 : .42,
        wireframe, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material); mesh.position.y = y; mesh.scale.setScalar(scale); mesh.renderOrder = 18; group.add(mesh); objects.push(mesh);
    };
    if (kind === "freeze") {
      add(new THREE.IcosahedronGeometry(3.2, 1), 2, 1, true);
      add(new THREE.OctahedronGeometry(1.8, 0), 2, 1, true);
    } else if (kind === "stun") {
      const ring = new THREE.TorusGeometry(2.7, .2, 6, 20); ring.rotateX(Math.PI / 2); add(ring, 7.2);
      const ring2 = new THREE.TorusGeometry(3.2, .14, 6, 20); ring2.rotateX(Math.PI / 2); add(ring2, 6.8, .8);
    } else if (kind === "burn") {
      for (let i = 0; i < 4; i++) { const flame = new THREE.ConeGeometry(.75, 2.4, 5); add(flame, (i % 2) * 1.3, 1); objects.at(-1)!.position.x = Math.cos(i * Math.PI / 2) * 2.7; objects.at(-1)!.position.z = Math.sin(i * Math.PI / 2) * 2.7; }
    } else {
      for (let i = 0; i < 5; i++) { add(new THREE.SphereGeometry(.48, 6, 5), Math.sin(i * 2.2) * 2 + i * .7, 1); objects.at(-1)!.position.x = Math.cos(i * 2.4) * 2.7; objects.at(-1)!.position.z = Math.sin(i * 2.4) * 2.7; }
    }
    return { group, objects, phase: 0 };
  }

  private remove(key: string, aura: Aura): void {
    aura.group.removeFromParent();
    for (const mesh of aura.objects) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    this.active.delete(key);
  }
}
