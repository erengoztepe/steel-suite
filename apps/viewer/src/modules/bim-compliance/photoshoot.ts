/**
 * Photoshoot mode: the model, and nothing else.
 *
 * For capturing a clean image once a section has been set up — the cut stays,
 * but the clipping plane's drag arrow and its rectangle outline go, along with
 * the axis gizmo, the floating labels, any measurements, the member vector
 * overlay and the whole UI. The GROUND GRID stays: it is the scene's datum, so
 * it reads as part of the picture rather than as an interface element.
 *
 * Split in two on purpose, because the things on screen live in two different
 * places:
 *
 *  - DOM chrome (panels, top bar, the CSS2D label layer) is hidden by CSS off a
 *    `data-photoshoot` attribute on the viewer root — see globals.css. A
 *    blanket "hide everything that is not the canvas" rule rather than a prop
 *    threaded through each panel: a panel added later should disappear from a
 *    photoshoot without anyone remembering to wire it up.
 *  - Scene objects are hidden here, and by ELIMINATION rather than by name: hide
 *    every direct child of the scene except the ones on a short keep list.
 *    Naming what to HIDE (measure group, vector group, …) would go stale the
 *    first time something new is added to the scene, whereas the keep list is
 *    closed: the loaded models, the lights (without them a Lambert-shaded model
 *    renders black) and the ground grid.
 *
 * Restoring puts back exactly what was there before, from a snapshot — so a
 * grid the user had already switched off does NOT come back on when they leave
 * photoshoot mode.
 */

import {
  Components,
  FragmentsManager,
  type OrthoPerspectiveCamera,
  type SimpleScene,
  type SimpleWorld,
} from "@thatopen/components";
import { Clipper } from "@thatopen/components";
import type { PostproductionRenderer } from "@thatopen/components-front";
import * as THREE from "three";

import { getGrid } from "./ProjectDetail/Viewer/grid-datum";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

/** Attribute the CSS hook reads. Also set on the root by StandaloneApp. */
export const PHOTOSHOOT_ATTR = "data-photoshoot";

interface Snapshot {
  objects: Map<THREE.Object3D, boolean>;
  clipperVisible: boolean;
}

let snapshot: Snapshot | null = null;

/**
 * Enter or leave photoshoot mode for the scene side.
 *
 * Idempotent in both directions: entering twice keeps the FIRST snapshot (so
 * the state it restores to is the one before any hiding), and leaving without
 * having entered does nothing.
 */
export function setScenePhotoshoot(components: Components, world: World | null, on: boolean): void {
  if (!world) return;
  const clipper = components.get(Clipper);

  if (on) {
    if (snapshot) return;
    const keep = new Set<THREE.Object3D>();
    for (const model of components.get(FragmentsManager).list.values()) keep.add(model.object);
    // The ground grid is scenery, not interface — it gives the shot its datum
    // and its sense of scale, so a photoshoot keeps it (its colour already
    // tracks the chosen background; see scene-background.ts).
    const grid = getGrid(components);
    if (grid) keep.add(grid.three);

    const objects = new Map<THREE.Object3D, boolean>();
    for (const child of world.scene.three.children) {
      if (keep.has(child)) continue;
      // Lights are not "things on screen" — they are how the model is lit at
      // all. `isLight` covers the ambient/directional pair SimpleScene.setup()
      // installs and anything added later.
      if ((child as THREE.Light).isLight) continue;
      objects.set(child, child.visible);
      child.visible = false;
    }
    snapshot = { objects, clipperVisible: clipper.visible };
    // The plane visuals only — `Clipper.visible` walks its planes and hides each
    // one's TransformControls helper AND its `_helper` origin, which is the
    // parent the app hangs the rectangle outline and guide lines off (see
    // `decoratePlane` in use-clip-tool). `enabled` is untouched, so the cut
    // itself stays exactly where the user put it.
    clipper.visible = false;
  } else {
    if (!snapshot) return;
    for (const [object, visible] of snapshot.objects) object.visible = visible;
    clipper.visible = snapshot.clipperVisible;
    snapshot = null;
  }

  // On-demand renderer: changing visibility flags moves no camera and fires no
  // event that would otherwise trigger a repaint.
  if (world.renderer) world.renderer.needsUpdate = true;
}
