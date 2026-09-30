import type { OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import { Components, FragmentsManager } from "@thatopen/components";
import { Highlighter, type PostproductionRenderer } from "@thatopen/components-front";
import * as THREE from "three";

/**
 * Animated isolation: the members outside a selection fade out (or back in)
 * while the camera glides to its new framing, both on one clock.
 *
 * Why materials and not items: fragments v3 has no per-item opacity — the only
 * per-item lever is `highlight()`, a worker round-trip that re-tiles, far too
 * slow to call every frame. But every fragment material is a plain
 * `THREE.Material` on the main thread (`core.models.materials.list`), and the
 * selected members never use them: they are painted by the "select" highlight,
 * which gets its OWN merged material (`{...original, ...highlight}`), and the
 * Highlighter tags every style's material with the style name as `customId`
 * (`updateColors`). Ramping every material NOT tagged with the select style's
 * name therefore fades exactly the non-selected members, and costs one number
 * per material per frame. Real visibility (`setVisible`) is still what
 * isolation ends in — the fade only covers the moment before it.
 */

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

export const ISOLATION_TRANSITION_MS = 1000;

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export function captureCameraPose(world: World): CameraPose {
  const controls = world.camera.controls;
  return {
    position: controls.getPosition(new THREE.Vector3()),
    target: controls.getTarget(new THREE.Vector3()),
  };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** `pose` moved toward its target by `fraction` of the distance — same angle, closer. */
export function pushInPose(pose: CameraPose, fraction: number): CameraPose {
  const position = pose.position.clone().sub(pose.target).multiplyScalar(1 - fraction).add(pose.target);
  return { position, target: pose.target.clone() };
}

interface SavedMaterialState {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

/**
 * Scales every non-selection fragment material's opacity by one factor and puts
 * each back exactly as found on `restore()`.
 *
 * Materials created WHILE a fade runs (tiles streaming in as the camera moves,
 * or the items `resetVisible` brings back) are caught on `onItemSet`, i.e.
 * synchronously at creation, before they can render a single frame at full
 * opacity.
 */
class MaterialFader {
  private readonly saved = new Map<THREE.Material, SavedMaterialState>();
  private factor = 1;
  private readonly list: {
    values(): IterableIterator<THREE.Material>;
    onItemSet: { add(h: (e: { value: THREE.Material }) => void): void; remove(h: (e: { value: THREE.Material }) => void): void };
  };
  private readonly onCreated = ({ value }: { value: THREE.Material }) => this.applyTo(value);
  private readonly selectName: string;

  constructor(components: Components) {
    const fragments = components.get(FragmentsManager);
    this.selectName = components.get(Highlighter).config.selectName;
    this.list = fragments.core.models.materials.list as unknown as MaterialFader["list"];
    this.list.onItemSet.add(this.onCreated);
  }

  private applyTo(material: THREE.Material): void {
    const userData = material.userData as { customId?: string } | undefined;
    if (userData?.customId === this.selectName) return;
    let state = this.saved.get(material);
    if (!state) {
      state = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
      this.saved.set(material, state);
      // depthWrite off: a fading shell must not hide the selected members or
      // its own far faces through the depth buffer — half-faded geometry that
      // still occludes reads as holes.
      material.transparent = true;
      material.depthWrite = false;
      material.needsUpdate = true;
    }
    material.opacity = state.opacity * this.factor;
  }

  set(factor: number): void {
    this.factor = factor;
    for (const material of this.list.values()) this.applyTo(material);
  }

  restore(): void {
    this.list.onItemSet.remove(this.onCreated);
    for (const [material, state] of this.saved) {
      material.opacity = state.opacity;
      material.transparent = state.transparent;
      material.depthWrite = state.depthWrite;
      material.needsUpdate = true;
    }
    this.saved.clear();
  }
}

/**
 * Locks camera input for the duration with a shield over the canvas. That one
 * element covers everything that reacts to the canvas: camera-controls listens
 * for pointer/wheel on the canvas itself, and Highlighter picking and the
 * navigation hook's click-to-pivot / double-click focus all filter on
 * `canvas.contains(event.target)` — a sibling on top receives the events instead.
 *
 * NOT `controls.enabled = false`: ThatOpen's `SimpleCamera.update()` only calls
 * `controls.update()` while `camera.enabled` (which IS `controls.enabled`) is
 * true, so disabling the controls also freezes the camera. The glide below
 * would then compute every frame while the view stood still, and the camera
 * would jump to the end pose the moment the lock lifted — the very jump this
 * transition exists to remove.
 */
function lockInput(world: World): () => void {
  const host = world.renderer?.three.domElement.parentElement;
  const shield = document.createElement("div");
  shield.style.cssText = "position:absolute;inset:0;z-index:40;cursor:progress;";
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const events = ["pointerdown", "pointerup", "click", "dblclick", "contextmenu", "wheel"] as const;
  for (const name of events) shield.addEventListener(name, swallow, { passive: false });
  host?.appendChild(shield);

  return () => shield.remove();
}

/**
 * The next animation frame — or, if none comes within `FRAME_FALLBACK_MS`, a
 * timer tick. A hidden tab gets no rAF at all, and extraction waits on this
 * transition: without the fallback, switching tabs mid-extract would stall it
 * until the user came back. The clock is wall time either way, so the
 * transition still ends on schedule, just without the in-between frames.
 */
const FRAME_FALLBACK_MS = 100;
function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      resolve(performance.now());
    };
    const raf = requestAnimationFrame(finish);
    const timer = setTimeout(finish, FRAME_FALLBACK_MS);
  });
}

/** Calls `onFrame(eased)` once per frame for `durationMs` of wall time, the last call with 1. */
async function runClock(durationMs: number, onFrame: (eased: number) => void): Promise<void> {
  const start = performance.now();
  for (;;) {
    const now = await nextFrame();
    const t = Math.min(1, (now - start) / durationMs);
    onFrame(easeInOutCubic(t));
    if (t >= 1) return;
  }
}

/**
 * A fragments update that is guaranteed to run, resolving the moment every
 * re-tiled mesh is in the scene — no sooner (a flash or a pop-in) and no later.
 *
 * Two library behaviours stand in the way, both measured:
 *  - `FragmentsModels.update()` is throttled: a call within `maxUpdateRate` ms
 *    of the previous one returns at once and does NOTHING, `force` included, and
 *    the camera-controls "update" listener (setupViewer) calls it on every moving
 *    frame. The throttle check is its synchronous first statement, so lifting the
 *    rate for exactly that call bypasses it without changing it for anyone else.
 *  - `update(true)`'s own wait is a fixed ~400 ms floor (it polls for the
 *    worker's FINISH every 200 ms, then sleeps a 200 ms buffer), while the worker
 *    itself was done in well under that. Instead this polls each model's public
 *    `isBusy` — true while loading, while its worker refresh is unfinished, or
 *    while tile requests are still queued — and drains the queue itself.
 */
export async function forceFragmentsUpdate(components: Components): Promise<void> {
  const fragments = components.get(FragmentsManager);
  const core = fragments.core;
  const rate = core.settings.maxUpdateRate;
  core.settings.maxUpdateRate = 0;
  let refreshed: Promise<void>;
  try {
    refreshed = core.update();
  } finally {
    core.settings.maxUpdateRate = rate;
  }
  await refreshed;
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  while ([...fragments.list.values()].some((model) => model.isBusy) && performance.now() < deadline) {
    core.models.update();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

/** Poll step, and a cap so a model that never settles can't hold the transition forever. */
const SETTLE_POLL_MS = 8;
const SETTLE_TIMEOUT_MS = 2000;

export interface IsolationTransitionOptions {
  /** "out": non-selected members go from opaque to invisible; "in": the reverse. */
  direction: "out" | "in";
  durationMs?: number;
  /** Camera glide over the same clock; omitted = the camera stays put. */
  camera?: { from: CameraPose; to: CameraPose };
  /**
   * Runs while the fading members are fully transparent — at the END of an
   * "out" (hide them for real) or the START of an "in" (un-hide them), so the
   * visibility flip itself is never seen.
   */
  whileInvisible?: () => Promise<void>;
  /** Called on the frame the fade itself starts — for UI motion that has to start with it. */
  onRampStart?: () => void;
}

// A second transition must not start while one is running: its fader would
// record the first one's half-faded opacity as "original" and restore to it.
let running: Promise<void> = Promise.resolve();

export function runIsolationTransition(
  components: Components,
  world: World,
  options: IsolationTransitionOptions,
): Promise<void> {
  const next = running.then(() => transition(components, world, options));
  running = next.catch(() => undefined);
  return next;
}

async function transition(components: Components, world: World, options: IsolationTransitionOptions): Promise<void> {
  const { direction, durationMs = ISOLATION_TRANSITION_MS, camera, whileInvisible, onRampStart } = options;
  const controls = world.camera.controls;
  const fader = new MaterialFader(components);
  const unlock = lockInput(world);
  const repaint = () => {
    if (world.renderer) world.renderer.needsUpdate = true;
  };
  const moveCamera = (from: CameraPose, to: CameraPose, eased: number) => {
    void controls.lerpLookAt(
      from.position.x, from.position.y, from.position.z,
      from.target.x, from.target.y, from.target.z,
      to.position.x, to.position.y, to.position.z,
      to.target.x, to.target.y, to.target.z,
      eased,
      false,
    );
    // Apply the pose to the three.js camera now, on this clock, instead of
    // waiting for the world's own update tick to pick it up.
    controls.update(0);
  };
  const landCamera = ({ position: p, target: q }: CameraPose) =>
    controls.setLookAt(p.x, p.y, p.z, q.x, q.y, q.z, false);
  // The visibility flip must be IN THE SCENE before the fade moves on: after a
  // reveal, or the members fade in from nothing and pop in later (a still camera
  // pulls no tiles); after a hide, or restoring the materials flashes them back.
  const flipVisibility = async () => {
    await whileInvisible?.();
    await forceFragmentsUpdate(components);
  };

  try {
    controls.stop();
    if (direction === "in") {
      fader.set(0);
      await flipVisibility();
    } else {
      fader.set(1);
    }

    onRampStart?.();
    await runClock(durationMs, (eased) => {
      fader.set(direction === "out" ? 1 - eased : eased);
      if (camera) moveCamera(camera.from, camera.to, eased);
      repaint();
    });
    if (camera) await landCamera(camera.to);
    if (direction === "out") await flipVisibility();
  } finally {
    fader.restore();
    unlock();
    repaint();
  }
}
