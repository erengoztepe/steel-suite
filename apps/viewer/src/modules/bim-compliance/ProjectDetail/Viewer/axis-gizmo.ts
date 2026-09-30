/**
 * Small "global axes" compass in the bottom-left corner of the viewport
 * (X=red, Y=green, Z=blue) that rotates to match the main camera's current
 * orientation. Drawn every frame directly on top of the main scene, in a
 * scissored corner viewport — the standard nav-cube/gizmo technique, so it
 * needs no extra DOM element or second canvas.
 *
 * Labels the IFC/Navisworks/IDEA StatiCa data convention (Z-up, right-handed),
 * NOT the three.js scene's own convention (Y-up) — the scene is Z-up→Y-up
 * rotated on load (see `ifcVecToScene` in draw-vectors.ts: scene = (ifc.x,
 * ifc.z, -ifc.y)), so the arrow directions below are that same mapping
 * applied to the IFC unit axes, meaning "Z" correctly points up on screen.
 */

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import type { PostproductionRenderer } from "@thatopen/components-front";
import * as THREE from "three";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

const GIZMO_SIZE_PX = 120;
const GIZMO_MARGIN_PX = 16;
const GIZMO_DISTANCE = 4;

/**
 * Horizontal gap (CSS px) the gizmo keeps clear of the left Connection
 * Library panel's own right edge — held constant whether that panel is
 * collapsed to its grab strip, mid-drag, or fully open, so the gizmo slides
 * right in lockstep with the panel instead of ever sitting under it.
 */
export const GIZMO_PANEL_GAP_PX = 40;

/** Gizmo's own footprint (CSS px, square) — the caller needs this to work out the gizmo's right edge for its own layout math. */
export const GIZMO_FOOTPRINT_PX = GIZMO_SIZE_PX;

const AXES: Array<{ dir: THREE.Vector3; color: number; label: string }> = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xef4444, label: "X" }, // IFC X -> scene X
  { dir: new THREE.Vector3(0, 0, -1), color: 0x22c55e, label: "Y" }, // IFC Y -> scene -Z
  { dir: new THREE.Vector3(0, 1, 0), color: 0x3b82f6, label: "Z" }, // IFC Z (elevation) -> scene Y
];

function makeLabelSprite(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.beginPath();
  ctx.arc(32, 32, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 32px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }),
  );
  sprite.scale.set(0.45, 0.45, 1);
  return sprite;
}

function buildGizmoScene(): THREE.Scene {
  const scene = new THREE.Scene();
  for (const { dir, color, label } of AXES) {
    scene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), 1, color, 0.25, 0.15));
    const sprite = makeLabelSprite(label, color);
    sprite.position.copy(dir).multiplyScalar(1.25);
    scene.add(sprite);
  }
  return scene;
}

function disposeGizmoScene(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const anyObj = obj as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    anyObj.geometry?.dispose?.();
    const mat = anyObj.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
    else mat?.dispose?.();
  });
}

/**
 * Renders the bottom-left global-axes compass for as long as the
 * world/camera/renderer are ready.
 *
 * @param leftInsetPx Live CSS-px distance from the viewport's left edge to
 * where the gizmo's own left edge should sit (the Connection Library panel's
 * current width + `GIZMO_PANEL_GAP_PX`). Read from a ref inside the per-frame
 * draw callback rather than closed over directly, so a live panel drag/resize
 * moves the gizmo every frame without tearing down and rebuilding the gizmo
 * scene/camera on every intermediate width.
 */
export function useAxisGizmo(worldRef: MutableRefObject<World | null>, ready: boolean, leftInsetPx: number) {
  const leftInsetRef = useRef(leftInsetPx);
  useEffect(() => {
    leftInsetRef.current = leftInsetPx;
  }, [leftInsetPx]);

  useEffect(() => {
    const world = worldRef.current;
    if (!ready || !world?.renderer || !world.camera) return;

    const renderer = world.renderer.three;
    const gizmoScene = buildGizmoScene();
    const gizmoCamera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);

    const prevViewport = new THREE.Vector4();
    const prevScissor = new THREE.Vector4();
    const dir = new THREE.Vector3();

    const draw = () => {
      const mainCamera = world.camera?.three;
      if (!mainCamera) return;

      mainCamera.getWorldDirection(dir);
      gizmoCamera.position.copy(dir).multiplyScalar(-GIZMO_DISTANCE);
      gizmoCamera.up.copy(mainCamera.up);
      gizmoCamera.lookAt(0, 0, 0);

      renderer.getViewport(prevViewport);
      renderer.getScissor(prevScissor);
      const prevScissorTest = renderer.getScissorTest();
      const prevAutoClear = renderer.autoClear;

      const left = Math.round(leftInsetRef.current);

      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.setScissorTest(true);
      renderer.setViewport(left, GIZMO_MARGIN_PX, GIZMO_SIZE_PX, GIZMO_SIZE_PX);
      renderer.setScissor(left, GIZMO_MARGIN_PX, GIZMO_SIZE_PX, GIZMO_SIZE_PX);
      renderer.render(gizmoScene, gizmoCamera);

      renderer.setViewport(prevViewport);
      renderer.setScissor(prevScissor);
      renderer.setScissorTest(prevScissorTest);
      renderer.autoClear = prevAutoClear;
    };

    world.renderer.onAfterUpdate.add(draw);
    return () => {
      world.renderer?.onAfterUpdate.remove(draw);
      disposeGizmoScene(gizmoScene);
    };
  }, [worldRef, ready]);
}
