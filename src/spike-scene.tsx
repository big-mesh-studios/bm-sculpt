/**
 * The Phase 0 spike scene: three questions, one page.
 *
 * Left is a sphere with smooth per-vertex normals. Its normals travel as two signed
 * 16-bit channels and are unfolded in the vertex shader, so if that fold is wrong the
 * sphere shades lumpy and faceted — a smooth surface is the visual proof that it is
 * right. Right is a box, whose six faces each carry one normal and one colour, which is
 * the other half of the proof: a decode that merely round-trips would make the box shade
 * smooth, and this one must not.
 *
 * Behind both is a 16³ volume addressed in world space through a `sampler3D`. The sphere
 * and the box are cut by it, and what is not covered is tinted toward the texel's own
 * address — so the volume is visible as a shape in space rather than as a pattern painted
 * onto the surfaces, and so a misaligned binding shows as a colour ramp rather than as a
 * shape that happens to look plausible.
 *
 * Kept, and reachable at `?spike`, because the application draws its chunks with the same
 * material and the same vertex layout. A spike that has been deleted cannot answer a
 * question about whether the thing that replaced it broke something.
 */

import { Color, Mesh } from "@random-mesh/rmsl/scene";

import { OrbitController } from "./controls/orbit-camera";
import type { PrecisionProbe } from "./render/precision";
import { SurfaceMaterial } from "./render/surface-material";
import { buildBox, buildSphere, toGeometry } from "./render/spike-geometry";
import { buildSpikeVolume } from "./render/spike-volume";
import { createViewport, type Viewport } from "./render/viewport";

const SPHERE_SEGMENTS = 64;
const SPHERE_RINGS = 32;

/** The counts the header shows, and the things there is to dispose of. */
export interface SpikeScene {
  readonly viewport: Viewport;
  readonly orbit: OrbitController;
  readonly counts: { readonly sphere: number; readonly box: number };
  dispose(): void;
}

export const buildSpikeScene = (
  canvas: HTMLCanvasElement,
  measured: PrecisionProbe,
): SpikeScene => {
  const sphereData = buildSphere(230, SPHERE_SEGMENTS, SPHERE_RINGS, {
    r: 236,
    g: 214,
    b: 168,
  });
  const boxData = buildBox({ x: 170, y: 170, z: 170 }, [
    { r: 214, g: 96, b: 84 },
    { r: 158, g: 70, b: 64 },
    { r: 236, g: 152, b: 96 },
    { r: 168, g: 108, b: 72 },
    { r: 132, g: 168, b: 214 },
    { r: 92, g: 126, b: 176 },
  ]);

  const viewport: Viewport = createViewport(canvas, {
    ...(measured.ok ? { precision: measured.precision } : {}),
  });
  viewport.setBackground(new Color(0.07, 0.07, 0.09));

  const material = new SurfaceMaterial();
  material.volume = buildSpikeVolume();

  const sphere = new Mesh(toGeometry(sphereData), material);
  sphere.position.set(-330, 0, 0);
  const box = new Mesh(toGeometry(boxData), material);
  box.position.set(330, 0, 0);
  viewport.scene.add(sphere, box);

  const orbit = new OrbitController(viewport.camera, { radius: 1150 });
  const detach = orbit.attach(canvas);
  orbit.apply();

  return {
    viewport,
    orbit,
    counts: { sphere: sphereData.vertexCount, box: boxData.vertexCount },
    dispose: () => {
      detach();
      sphere.geometry.dispose();
      box.geometry.dispose();
      material.volume?.dispose();
      viewport.dispose();
    },
  };
};
