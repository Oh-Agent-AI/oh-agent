/** Turntable for the four mecha meshes. The board underneath stays the rules surface. */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { m } from "../engine/worldScale";
import { createAssault, createBoss, createGunner, createSupport, disposeMechaModel } from "./mecha/models";

export function MechaLineup({ label }: { label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#c5d7ea", "#24180f", 1.15));
    const sun = new THREE.DirectionalLight("#fff4e0", 1.6);
    sun.position.set(12, 28, 18);
    scene.add(sun);

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(m(108), m(0.2), m(72)),
      new THREE.MeshStandardMaterial({ color: "#1a3048", roughness: 0.92 }),
    );
    deck.position.set(m(6), m(0.1), m(8));
    scene.add(deck);
    const cell = new THREE.Mesh(
      new THREE.BoxGeometry(m(16), m(0.08), m(16)),
      new THREE.MeshStandardMaterial({ color: "#244864", roughness: 0.8 }),
    );
    cell.position.set(m(-26), m(0.22), m(2));
    scene.add(cell);
    const arena = new THREE.Mesh(
      new THREE.BoxGeometry(m(32), m(0.08), m(32)),
      new THREE.MeshStandardMaterial({ color: "#3a2a38", roughness: 0.86 }),
    );
    arena.position.set(m(30), m(0.22), m(6));
    scene.add(arena);

    const figures = [createAssault(), createGunner(), createSupport(), createBoss()];
    // Camera stays on -Z, the facing direction. The alien stands beside the file so its face is not hidden behind a mech.
    figures[0].position.set(m(-26), 0, m(2));
    figures[1].position.set(m(-8), 0, m(4));
    figures[2].position.set(m(8), 0, m(2));
    figures[3].position.set(m(30), 0, m(6));
    for (const figure of figures) scene.add(figure);

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
    const center = new THREE.Vector3(m(2), m(10), m(4));
    camera.position.set(m(14), m(16), m(-64));
    camera.lookAt(center);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const draw = () => {
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (width > 0 && height > 0) {
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      if (!reduce) {
        const yaw = Math.sin(performance.now() * 0.00035) * 0.16;
        camera.position.x = m(14) + Math.sin(yaw) * m(6);
        camera.position.z = m(-64) - (1 - Math.cos(yaw)) * m(2);
        camera.lookAt(center);
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      for (const figure of figures) disposeMechaModel(figure);
      deck.geometry.dispose();
      (deck.material as THREE.Material).dispose();
      cell.geometry.dispose();
      (cell.material as THREE.Material).dispose();
      arena.geometry.dispose();
      (arena.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div className="mecha-stage">
      <canvas ref={canvasRef} aria-label={label} />
    </div>
  );
}
