import * as THREE from "three";

export type PreviewEntityObjectKind = "scene-model" | "scene-collider" | "scene-anchor";
export type PreviewEntityMetadata = Readonly<{ entityId: string; label: string; kind: PreviewEntityObjectKind }>;

const metadataKey = "__ohAgentPreviewEntity";

export function markPreviewEntityObject(object: THREE.Object3D, metadata: PreviewEntityMetadata): void {
  if (!metadata.entityId || metadata.entityId.length > 256 || !metadata.label || metadata.label.length > 256) throw new Error("preview_entity_metadata_invalid");
  object.userData[metadataKey] = { ...metadata };
}

export class PreviewDecorRegistry {
  private readonly points = new Map<string, THREE.Vector3>();

  remember(entityId: string, point: THREE.Vector3): void {
    if (this.points.size >= 256 && !this.points.has(entityId)) this.points.delete(this.points.keys().next().value!);
    this.points.set(entityId, point.clone());
  }

  get(entityId: string): THREE.Vector3 | null {
    return this.points.get(entityId) ?? null;
  }

  clear(): void {
    this.points.clear();
  }
}

export class PreviewEntityRegistry {
  private readonly roots = new Map<THREE.Object3D, Map<string, THREE.Object3D>>();
  private readonly entities = new Map<string, THREE.Object3D>();

  register(root: THREE.Object3D): void {
    if (this.roots.has(root)) return;
    const entries = new Map<string, THREE.Object3D>();
    root.traverse(object => {
      const metadata = object.userData[metadataKey] as PreviewEntityMetadata | undefined;
      if (!metadata) return;
      if (!metadata.entityId || this.entities.has(metadata.entityId) || entries.has(metadata.entityId)) throw new Error("preview_entity_duplicate");
      entries.set(metadata.entityId, object);
    });
    this.roots.set(root, entries);
    for (const [entityId, object] of entries) this.entities.set(entityId, object);
  }

  unregister(root: THREE.Object3D): void {
    const entries = this.roots.get(root);
    if (!entries) return;
    for (const entityId of entries.keys()) this.entities.delete(entityId);
    this.roots.delete(root);
  }

  get(entityId: string): THREE.Object3D | null {
    return this.entities.get(entityId) ?? null;
  }

  metadataFor(object: THREE.Object3D): PreviewEntityMetadata | null {
    const metadata = object.userData[metadataKey] as PreviewEntityMetadata | undefined;
    return metadata && this.entities.get(metadata.entityId) === object ? metadata : null;
  }

  entityIdFor(object: THREE.Object3D): string | null {
    return this.metadataFor(object)?.entityId ?? null;
  }

  resolve(object: THREE.Object3D): THREE.Object3D | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      const metadata = current.userData[metadataKey] as PreviewEntityMetadata | undefined;
      if (metadata && this.entities.get(metadata.entityId) === current) return current;
      if (this.roots.has(current)) return null;
      current = current.parent;
    }
    return null;
  }

  pickableRoots(): readonly THREE.Object3D[] {
    return [...this.roots.keys()];
  }

  clear(): void {
    this.roots.clear();
    this.entities.clear();
  }
}
