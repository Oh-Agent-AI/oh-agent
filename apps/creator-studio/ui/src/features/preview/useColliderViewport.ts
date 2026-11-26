import { useEffect } from "react";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { validateSceneDraft } from "@oh-agent/city-sdk";
import type { CityEngine } from "../../../../../agent-city/ui/src/engine/CityEngine";
import { m } from "../../../../../agent-city/ui/src/engine/worldScale";
import type { AgentColliderPreview } from "./sceneColliderPreview";

export function useColliderViewport(engine: CityEngine | null, savedScene: unknown, preview: AgentColliderPreview | null) {
  useEffect(() => {
    if (!engine) return;
    const checked = validateSceneDraft(savedScene);
    const saved = checked.ok ? checked.value.objects.filter(object => object.kind === "collider") : [];
    const hiddenIds = new Set(preview?.removed);
    const group = new Group();
    const geometry = new BoxGeometry(1, 1, 1);
    const savedMaterial = new MeshBasicMaterial({ color: 0x80acfb, transparent: true, opacity: 0.34, depthWrite: false });
    const previewMaterial = new MeshBasicMaterial({ color: 0x32edb4, transparent: true, opacity: 0.66, depthWrite: false });
    for (const object of [...saved.filter(item => !hiddenIds.has(item.id)), ...(preview?.boxes ?? [])]) {
      const { positionMeters: position, rotationRadians: rotation, scale } = object.transform;
      const box = new Mesh(geometry, preview?.boxes.includes(object) ? previewMaterial : savedMaterial);
      box.position.set(m(position.x), m(position.y), m(position.z));
      box.rotation.set(rotation.x, rotation.y, rotation.z);
      box.scale.set(m(object.sizeMeters.x * scale.x), m(object.sizeMeters.y * scale.y), m(object.sizeMeters.z * scale.z));
      group.add(box);
    }
    if (group.children.length) engine.addOverlay(group);
    const focus = preview?.boxes[0] ?? saved.find(item => hiddenIds.has(item.id));
    if (focus) engine.focusPoint(m(focus.transform.positionMeters.x), m(focus.transform.positionMeters.z));
    return () => {
      if (group.children.length) engine.removeOverlay(group);
      geometry.dispose();
      savedMaterial.dispose();
      previewMaterial.dispose();
    };
  }, [engine, savedScene, preview]);
}
