import {
  Components,
  FragmentsManager,
  Grids,
  OrthoPerspectiveCamera,
  SimpleScene,
  SimpleWorld,
  Worlds,
} from "@thatopen/components";
import { GraphicVertexPicker, Highlighter, PostproductionRenderer } from "@thatopen/components-front";
import { RenderedFaces } from "@thatopen/fragments";
import CameraControls from "camera-controls";
import * as THREE from "three";

import { registerModelTintStyles } from "./model-tint";
import { installAdaptiveNear } from "./ProjectDetail/Viewer/adaptive-near";

// This positioning assumes the model will close to the 0,0 x,z coordinates.
const DEFAULT_CAMERA_PARAMS = [50, 20, 50, 0, 0, 0] as const;

interface SetupViewerProps {
  viewerRef: React.RefObject<HTMLDivElement>;
  components: Components;
}

const setupViewer = async ({
  viewerRef,
  components,
}: SetupViewerProps): Promise<SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>> => {
  const worlds = components.get(Worlds);
  const world = worlds.create<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>();

  world.scene = new SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = null;

  world.renderer = new PostproductionRenderer(components, viewerRef.current!);

  world.camera = new OrthoPerspectiveCamera(components);
  world.camera.controls.setLookAt(...DEFAULT_CAMERA_PARAMS); // convenient position for the model we will load

  // Slow down wheel zoom — default is far too aggressive for IFC models.
  // (useViewerNavigation overrides dollySpeed dynamically per modifier key and
  // distance; this is just the pre-mount default.)
  world.camera.controls.dollySpeed = 0.36;
  // world.camera.controls.wheelDeltaFactor = 0.05;

  // Orbit around the point under the cursor instead of a fixed world origin.
  world.camera.controls.infinityDolly = true;
  (world.camera.controls as unknown as { dynamicAnchor: boolean }).dynamicAnchor = true;

  // Base mouse-button scheme (per-press modifier variants are layered on top
  // of this by useViewerNavigation, which reassigns left/right dynamically on
  // every pointerdown; these are just the plain/no-modifier defaults):
  //   left:   none (bare left-drag does nothing; click still handled
  //           separately for selection + pivot re-centering)
  //   right:  pan/truck (unchanged from the library default)
  //   middle: none (dolly-via-middle-drag removed)
  world.camera.controls.mouseButtons.left = CameraControls.ACTION.NONE;
  world.camera.controls.mouseButtons.right = CameraControls.ACTION.TRUCK;
  world.camera.controls.mouseButtons.middle = CameraControls.ACTION.NONE;

  // Registered before any tool's camera listener (the measure tool narrows the
  // near plane further while armed and must run after this). World lifetime.
  installAdaptiveNear(world);

  // GraphicVertexPicker is registered by PostproductionRenderer's constructor.
  // Its `enabled` setter immediately calls `this.get()` which requires a world.
  // Assign the world before components.init() to prevent the unhandled error.
  // Wrapped in try-catch: GraphicVertexPicker may not extend the Base class in
  // some @thatopen/components-front versions, causing Components.get() to throw.
  try {
    (components.get(GraphicVertexPicker as any) as any).world = world;
  } catch {
    // Vertex picker unavailable — viewer still works without it.
  }

  await components.init();

  const grids = components.get(Grids);
  const grid = grids.create(world);
  grid.setup({});

  const fragmentsManager = components.get(FragmentsManager);
  await fragmentsManager.init("/worker.mjs");

  const highlighter = components.get(Highlighter);
  // FIRST, before setup() and before every other styles.set below: highlighter
  // styles paint in registration order, so registering the per-model tints here
  // is what keeps select / focus / compliance / red-highlight winning over a
  // tint instead of the other way round. See model-tint.ts.
  registerModelTintStyles(highlighter);
  // Ctrl+click adds to the selection (library default); Shift is reserved for
  // drag gestures (see useViewerNavigation).
  highlighter.multiple = "ctrlKey";
  // Ctrl+clicking an ALREADY-selected element deselects it instead of being a
  // no-op re-add — native Highlighter feature, opt-in per selection name.
  highlighter.autoToggle.add("select");
  await highlighter.setup({
    world,
    selectName: "select", // This enables the select functionality
    selectEnabled: true,
    selectMaterialDefinition: {
      color: new THREE.Color().setHex(0xff3333),
      renderedFaces: RenderedFaces.ONE,
      opacity: 1,
      transparent: false,
    },
  });

  highlighter.styles.set("compliant", {
    color: new THREE.Color().setHex(0x1f8a57),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  highlighter.styles.set("non-compliant", {
    color: new THREE.Color().setHex(0xdf1c41),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  highlighter.styles.set("not-applicable", {
    color: new THREE.Color().setHex(0xd97706),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  highlighter.styles.set("ghost", {
    color: new THREE.Color(0x888888), // Gray color
    opacity: 0.15, // Low opacity
    transparent: true,
    renderedFaces: RenderedFaces.ONE, // Assuming RenderedFaces.ONE
    depthTest: true,
  });

  // Rapid double-right-click "focus" — visually distinct from the red
  // "select" highlight; marks the element the camera is centered on WITHOUT
  // adding it to the actual selection (see useViewerNavigation).
  highlighter.styles.set("focus", {
    color: new THREE.Color().setHex(0x38bdf8),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  // Clash Detection v2: red = clashing elements, green = non-clashing (in test)
  highlighter.styles.set("clash", {
    color: new THREE.Color().setHex(0xdf1c41),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("no-clash", {
    color: new THREE.Color().setHex(0x1f8a57),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  // Value Engineering catalog — amber for candidate elements (height/thickness/space removal).
  highlighter.styles.set("ve-target", {
    color: new THREE.Color().setHex(0xf59e0b),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  // Boundary-walls compass — solid green for walls flagged as plot perimeter.
  highlighter.styles.set("boundary-wall", {
    color: new THREE.Color().setHex(0x16a34a),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  // Inspection — IsExternal-style colored buckets used by Wall/Door/Window
  // external scenarios. Red = true, Green = false, Grey = unknown.
  highlighter.styles.set("pset-true", {
    color: new THREE.Color().setHex(0xdc2626),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("pset-false", {
    color: new THREE.Color().setHex(0x16a34a),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("pset-unknown", {
    color: new THREE.Color().setHex(0x6b7280),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  // Mislabeled — amber outline-ish for "Claude says this needs review".
  highlighter.styles.set("review-flag", {
    color: new THREE.Color().setHex(0xf59e0b),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  // T1.4 — Color-by-discipline styles. One per Aldar discipline code so the catalog
  // can recolor entire models when the user toggles "Color by Discipline" in the
  // catalog toolbar. Colors come from `DISCIPLINE_CODE_MAP`. Style names:
  // `disc-AR`, `disc-ST`, etc.
  const DISC_COLORS: Record<string, number> = {
    AR: 0x60a5fa, ST: 0xf87171, ME: 0x34d399, EL: 0xfbbf24,
    FP: 0xc084fc, PW: 0xfb923c, ID: 0x22d3ee, LA: 0xe879f9,
    LC: 0xa3e635, FC: 0xf472b6, GS: 0x38bdf8, DR: 0xfacc15,
  };
  for (const [code, hex] of Object.entries(DISC_COLORS)) {
    highlighter.styles.set(`disc-${code}`, {
      color: new THREE.Color().setHex(hex),
      renderedFaces: RenderedFaces.ONE,
      opacity: 1,
      transparent: false,
    });
  }

  highlighter.styles.set("anim-not-started", {
    color: new THREE.Color(0x888888),
    renderedFaces: RenderedFaces.ONE,
    opacity: 0.12,
    transparent: true,
  });
  highlighter.styles.set("anim-in-progress", {
    color: new THREE.Color().setHex(0xf59e0b),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("anim-completed", {
    color: new THREE.Color().setHex(0x22c55e),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  highlighter.styles.set("diff-unchanged", {
    color: new THREE.Color(0x868e96),
    renderedFaces: RenderedFaces.ONE,
    opacity: 0.15,
    transparent: true,
    depthTest: true,
  });
  highlighter.styles.set("diff-modified", {
    color: new THREE.Color().setHex(0xf59e0b),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("diff-added", {
    color: new THREE.Color().setHex(0x22c55e),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("diff-removed", {
    color: new THREE.Color().setHex(0xef4444),
    renderedFaces: RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });

  // Drive tile streaming every animation frame (matching the official ThatOpen example).
  // Using "update" instead of "rest" keeps the worker heartbeat alive so tiles stream
  // continuously — without this, geometry may never appear after an initial load.
  world.camera.controls.addEventListener("update", () => fragmentsManager.core.update());

  world.onCameraChanged.add((camera) => {
    fragmentsManager.list.forEach((model) => {
      model.useCamera(camera.three);
    });
    fragmentsManager.core.update(true);
  });

  fragmentsManager.onFragmentsLoaded.add(async (model) => {
    if (world.scene) {
      world.scene.three.add(model);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model.items.forEach((fragment: any) => {
        if (fragment.mesh) {
          world.meshes.add(fragment.mesh); // Use the existing mesh, don't create new one
        }
      });
    }

    // await indexer.process(model);
  });

  // world.camera.controls.addEventListener("update", () => fragmentsManager.core.update(true));

  // Ensures that once the Fragments model is loaded
  // (converted from the IFC in this case),
  // it utilizes the world camera for updates
  // and is added to the scene.
  fragmentsManager.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragmentsManager.core.update(true);
  });

  return world;
};

export default setupViewer;
