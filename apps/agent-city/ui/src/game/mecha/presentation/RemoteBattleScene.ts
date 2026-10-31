import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../../../render/mecha/models";
import type { RemoteArenaV1 } from "../contracts/arena";
import type { MatchSnapshot, TurnResolved } from "../contracts/match";
import type { Cell, MatchState } from "../rules";
import type { PvpState } from "../rules/pvp";
import type { PresentationSnapshot, PresentationStages } from "../presentationSnapshot";
import type { BattleScenePort } from "./BattleScenePort";

const terrainColors = { land: "#426b4d", water: "#276e92", mountain: "#73543b", road: "#77786f" } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteBattleScene implements BattleScenePort {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  private readonly mechs: Record<string, THREE.Group>;
  private readonly boss: THREE.Group;
  private readonly raiders: THREE.Group[];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly picks: THREE.Mesh[] = [];
  private readonly resize: ResizeObserver;
  private readonly onPointerUp: (event: PointerEvent) => void;
  private readonly canvas: HTMLCanvasElement;
  private readonly onCell: (cell: Cell) => void;
  private arena: RemoteArenaV1 | null = null;
  private frame = 0;
  private paused = false;
  private disposed = false;
  private playSequence = 0;

  constructor(canvas: HTMLCanvasElement, onCell: (cell: Cell) => void) {
    this.canvas = canvas;
    this.onCell = onCell;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color("#152333");
    this.scene.fog = new THREE.Fog("#152333", 100, 260);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 220;
    this.scene.add(new THREE.HemisphereLight("#d9edff", "#263226", 2.2));
    const sun = new THREE.DirectionalLight("#fff1d4", 2.4);
    sun.position.set(50, 90, 30);
    this.scene.add(sun);
    this.scene.add(this.root);
    this.mechs = {
      Assault: createAssault(), Gunner: createGunner(), Support: createSupport(),
      "A:Assault": createAssault(), "A:Gunner": createGunner(), "A:Support": createSupport(),
      "B:Assault": createAssault(), "B:Gunner": createGunner(), "B:Support": createSupport(),
    };
    this.boss = createBoss();
    this.raiders = [createRaider(), createRaider()];
    for (const group of [...Object.values(this.mechs), this.boss, ...this.raiders]) {
      group.scale.multiplyScalar(2);
      this.root.add(group);
    }
    this.onPointerUp = (event) => this.pick(event);
    canvas.addEventListener("pointerup", this.onPointerUp);
    this.resize = new ResizeObserver(() => this.resizeCanvas());
    this.resize.observe(canvas);
    this.resizeCanvas();
    this.animate();
  }

  applySnapshot(snapshot: MatchSnapshot<MatchState | PvpState>) {
    this.playSequence += 1;
    if (this.arena !== snapshot.arena) {
      this.arena = snapshot.arena;
      this.rebuildArena();
    }
    this.applyState(snapshot.state);
  }

  async playTurn(turn: TurnResolved<MatchState | PvpState>) {
    const sequence = ++this.playSequence;
    const stages = turn.presentationStages;
    if (stages) {
      for (const stage of this.stages(stages)) {
        await sleep(320);
        if (this.disposed || sequence !== this.playSequence) return;
        this.applyPresentation(stage);
      }
    }
    if (!this.disposed && sequence === this.playSequence) this.applyState(turn.state);
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  dispose() {
    this.disposed = true;
    this.playSequence += 1;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    for (const group of [...Object.values(this.mechs), this.boss, ...this.raiders]) disposeMechaModel(group);
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      }
    });
    this.renderer.dispose();
  }

  private stages(stages: PresentationStages): PresentationSnapshot[] {
    return [stages.before, stages.afterMovement, stages.afterPlayer, stages.afterEnemy, stages.afterPrepare];
  }

  private applyState(state: MatchState | PvpState) {
    for (const group of Object.values(this.mechs)) group.visible = false;
    this.boss.visible = false;
    for (const group of this.raiders) group.visible = false;
    if ("units" in state) {
      for (const mech of state.units) this.place(this.mechs[mech.id], mech.pos, mech.hp > 0);
      return;
    }
    for (const mech of state.mechs) this.place(this.mechs[mech.id], mech.pos, mech.hp > 0);
    this.place(this.boss, state.boss.anchor, state.boss.hp > 0);
    this.raiders.forEach((group, index) => {
      const raider = state.raiders[index];
      group.visible = Boolean(raider && raider.hp > 0);
      if (raider) this.place(group, raider.pos, raider.hp > 0);
    });
  }

  private applyPresentation(state: PresentationSnapshot) {
    for (const group of Object.values(this.mechs)) group.visible = false;
    for (const group of this.raiders) group.visible = false;
    for (const mech of state.mechs) this.place(this.mechs[mech.id], mech.pos, mech.hp > 0);
    this.place(this.boss, state.boss.anchor, state.boss.hp > 0);
    this.raiders.forEach((group, index) => {
      const raider = state.raiders[index];
      if (!raider) { group.visible = false; return; }
      this.place(this.mechs[raider.id] ?? group, raider.pos, raider.hp > 0);
    });
  }

  private place(group: THREE.Group, cell: Cell, visible: boolean) {
    const at = this.cellWorld(cell);
    group.position.set(at.x, at.y + 0.3, at.z);
    group.visible = visible;
  }

  private cellWorld(cell: Cell) {
    const arena = this.arena!;
    const lx = (cell.x + 0.5) * arena.cellW;
    const lz = (cell.y + 0.5) * arena.cellD;
    const c = Math.cos(arena.yaw);
    const s = Math.sin(arena.yaw);
    return {
      x: arena.originX + lx * c + lz * s,
      y: arena.heights[cell.y]?.[cell.x] ?? 0,
      z: arena.originZ - lx * s + lz * c,
    };
  }

  private rebuildArena() {
    const arena = this.arena!;
    for (const pick of this.picks) this.root.remove(pick);
    this.picks.length = 0;
    for (const child of [...this.root.children]) {
      if (child.userData.arena) this.root.remove(child);
    }
    const padGeometry = new THREE.BoxGeometry(arena.cellW - 0.35, 0.35, arena.cellD - 0.35);
    const pickGeometry = new THREE.BoxGeometry(arena.cellW, 1, arena.cellD);
    const pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) {
      const at = this.cellWorld({ x, y });
      const terrain = arena.terrain[y]?.[x] ?? "land";
      const pad = new THREE.Mesh(padGeometry, new THREE.MeshStandardMaterial({ color: terrainColors[terrain], roughness: 1 }));
      pad.position.set(at.x, at.y - 0.15, at.z);
      pad.rotation.y = arena.yaw;
      pad.userData.arena = true;
      this.root.add(pad);
      const pick = new THREE.Mesh(pickGeometry, pickMaterial);
      pick.position.set(at.x, at.y + 0.3, at.z);
      pick.rotation.y = arena.yaw;
      pick.userData.cell = { x, y };
      this.picks.push(pick);
      this.root.add(pick);
    }
    for (const building of arena.buildings) {
      const cell = building.cells[0];
      if (!cell) continue;
      const at = this.cellWorld(cell);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(arena.cellW * 0.72, building.height, arena.cellD * 0.72),
        new THREE.MeshStandardMaterial({ color: "#c5a26d", roughness: 0.8 }),
      );
      mesh.position.set(at.x, at.y + building.height / 2, at.z);
      mesh.rotation.y = building.yaw;
      mesh.userData.arena = true;
      this.root.add(mesh);
    }
    const center = this.cellWorld({ x: 4, y: 4 });
    this.camera.position.set(center.x + 75, center.y + 95, center.z + 95);
    this.controls.target.set(center.x, center.y, center.z);
    this.controls.update();
  }

  private pick(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.picks, false)[0];
    if (hit) this.onCell(hit.object.userData.cell as Cell);
  }

  private resizeCanvas() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (this.paused || document.hidden) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
