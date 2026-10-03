/**
 * A probe for the sky: stand one thing up, render a frame, and count what came out.
 *
 * ## Why this page exists
 *
 * Every test in this project asks whether the sky is *shaped* correctly, and the answer
 * was yes through three separate faults that a player reported and no test could see:
 * a starfield whose stars were smaller than a pixel, a moon at its true size (eight
 * pixels on a phone), and a cloud layer that had never drawn a cloud because the volume's
 * vertical address was off by 699 units. All three compiled, all three had green tests,
 * and all three were invisible from the host.
 *
 * So this is the missing instrument, and it exists in two modes:
 *
 * - **`/sky-probe.html`** renders the dome (and with `?clouds`, the layer) on their own,
 *   reads the framebuffer back, and prints **how many pixels each one lit**.
 * - **`/sky-probe.html?compile`** skips the render entirely and reports whether each
 *   material's two stages **compile and link** on this device.
 *
 * The second mode is not redundant. "Too big to compile" is a failure mode particular to
 * one GPU — a raymarched fragment shader is a very large program, and a driver that
 * refuses it throws inside the renderer, which is indistinguishable from a sky that drew
 * nothing. No test process can answer it; a phone can, in one page load.
 *
 * ```
 * vite dev        # then open /sky-probe.html
 *                 #   ?t=900          midnight, when the stars are due
 *                 #   ?clouds         add the cloud layer
 *                 #   ?elevation=45    where to look, degrees above the horizon
 *                 #   ?w=640&h=360     the frame to measure
 *                 #   ?box            a red control cube, for "is anything drawing"
 *                 #   ?compile         report shader compilation and stop
 * ```
 *
 * The numbers are on the page beside the pixels they describe, because a screenshot is
 * the artefact a person can read. It is the same argument as `?spike`, which is kept for
 * exactly this reason: when something in the sky looks wrong, this is the first question
 * to ask, and it answers in numbers rather than in adjectives.
 */

import { compileGlsl } from "@random-mesh/rmsl/glsl";
import {
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Vector3,
} from "@random-mesh/rmsl/scene";

import { dayNightState, phaseAt, type DayNightState } from "./world/day-night";
import { SkyMaterial, createSky } from "./world/sky";
import { CloudMaterial, createClouds, type Clouds } from "./world/clouds";
import { bakeCloudField } from "./world/cloud-field";
import { shapeTexture, weatherTexture } from "./world/cloud-textures";
import { SurfaceMaterial } from "./render/surface-material";
import { detectFragmentPrecision } from "./render/precision";
import { createViewport, type Viewport } from "./render/viewport";

const number = (name: string, fallback: number): number => {
  const raw = new URLSearchParams(location.search).get(name);
  const value = Number(raw);
  return raw !== null && Number.isFinite(value) ? value : fallback;
};

const options = {
  t: number("t", 900),
  elevation: number("elevation", 30),
  clouds: new URLSearchParams(location.search).has("clouds"),
  box: new URLSearchParams(location.search).has("box"),
  compile: new URLSearchParams(location.search).has("compile"),
  w: number("w", 640),
  h: number("h", 360),
};

const canvas = document.createElement("canvas");
document.body.style.cssText =
  "margin:0;background:#141414;color:#ddd;font:13px ui-monospace,monospace;padding:8px";
document.body.appendChild(canvas);

const readout = document.createElement("pre");
document.body.appendChild(readout);

/** What one frame contained. */
interface Measured {
  lit: number;
  mean: number;
  peak: number;
  histogram: number[];
}

/**
 * Reads the framebuffer back.
 *
 * `gl.readPixels` is the only way to ask what a shader actually did, and it is why this
 * page exists rather than a screenshot alone: a screenshot needs an eye and a
 * comparison, and this is a number.
 */
const measure = (viewport: Viewport): Measured => {
  const gl = viewport.renderer.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let lit = 0;
  let sum = 0;
  let peak = 0;
  const histogram = new Array(8).fill(0);
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
    sum += luma;
    if (luma > peak) peak = luma;
    // 24 is one eight-bit step above a night sky of 2, and one below a lit star.
    if (luma > 24) lit++;
    histogram[Math.min(7, luma >> 5)]!++;
  }
  return { lit, mean: sum / (pixels.length / 4), peak, histogram };
};

/**
 * Compiles each material's two stages with plain WebGL and reports what the driver said.
 *
 * Written against raw GL rather than through rmsl's renderer because rmsl's renderer
 * *throws* on a failed compile, and this page's whole value is in reporting the failure
 * instead of dying on it.
 */
const compileReport = (gl: WebGL2RenderingContext): string[] => {
  const lines: string[] = [];
  const field = bakeCloudField(20260901, 20, 60);
  const sky = new SkyMaterial();
  sky.sky.lighting = dayNightState(900);
  const clouds = new CloudMaterial(
    shapeTexture(field.shape),
    weatherTexture(field.weather),
  );
  const terrain = new SurfaceMaterial();
  terrain.sky.lighting = dayNightState(300);

  for (const [name, material] of [
    ["sky", sky],
    ["cloud", clouds],
    ["terrain", terrain],
  ] as const) {
    const program = material.build(new Scene());
    const stages: [string, number, string][] = [
      [
        "vertex",
        gl.VERTEX_SHADER,
        compileGlsl.vertex(program.vertexRoot, { precision: "highp" }),
      ],
      [
        "fragment",
        gl.FRAGMENT_SHADER,
        compileGlsl.fragment(program.fragmentRoot, { precision: "highp" }),
      ],
    ];
    const shaders: WebGLShader[] = [];
    let ok = true;
    for (const [stage, type, source] of stages) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!(gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean)) {
        lines.push(
          `${name} ${stage}: FAILED\n${(gl.getShaderInfoLog(shader) ?? "").trim()}`,
        );
        ok = false;
      }
      shaders.push(shader);
    }
    if (!ok) continue;
    // A program can link when both stages compile, and it can fail for reasons no
    // stage reports — so it is linked here rather than assumed.
    const linked = gl.createProgram();
    for (const shader of shaders) gl.attachShader(linked, shader);
    gl.linkProgram(linked);
    if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
      lines.push(
        `${name}: LINK FAILED\n${(gl.getProgramInfoLog(linked) ?? "").trim()}`,
      );
      continue;
    }
    lines.push(`${name}: both stages compiled and linked`);

    // **Which uniforms survived the link.** A driver that drops one reports a null
    // location here, and rmsl's upload loop skips a null location — so the uniform keeps
    // whatever the GL default is, which for a colour is `vec3(0)`. That is the whole of
    // "the clouds are black and the sky is not": a colour uniform that reads as zero, in
    // one material and not the other. It is the one thing in this file that cannot be
    // seen from a host process, because it is the driver's own optimiser deciding.
    const missing: string[] = [];
    for (const binding of program.uniforms) {
      if (gl.getUniformLocation(linked, binding.node.name) === null) {
        missing.push(binding.node.name);
      }
    }
    lines.push(
      missing.length === 0
        ? `${name}: all ${program.uniforms.length} uniforms kept their locations`
        : `${name}: DROPPED BY THE LINK — ${missing.join(", ")} (these read as zero)`,
    );
    for (const sampler of program.samplers) {
      lines.push(
        `${name} sampler ${sampler.name} (${sampler.type}): ${
          gl.getUniformLocation(linked, sampler.name) === null
            ? "DROPPED"
            : "kept"
        }`,
      );
    }
  }
  return lines;
};

const describe = (
  state: DayNightState,
  frame: Measured,
  clouds: Clouds | null,
  pixelRatio: number,
): string => {
  const megapixels = (options.w * options.h * pixelRatio * pixelRatio) / 1e6;
  return [
    `t=${state.elapsed}s · ${phaseAt(state.elapsed)} · twilight ${state.twilight.toFixed(2)} · sun ${state.sunElevation.toFixed(1)}° · moon ${state.moonElevation.toFixed(1)}°`,
    state.twilight > 0.9
      ? `STARS: ${frame.lit} lit pixels — ${(frame.lit / megapixels).toFixed(0)} per megapixel`
      : `stars are not due at this hour (twilight ${state.twilight.toFixed(2)})`,
    `mean luma ${frame.mean.toFixed(1)} · peak ${frame.peak} · luma histogram ${frame.histogram.join(" ")}`,
    clouds === null
      ? "clouds: not requested (?clouds)"
      : `CLOUDS: built, coverage ${clouds.material.coverage.toFixed(2)}, density ${clouds.material.density.toFixed(2)} — a frame with cloud in it has a peak well above the sky's own`,
  ].join("\n");
};

const run = (): void => {
  const precision = detectFragmentPrecision();
  canvas.width = options.w;
  canvas.height = options.h;
  canvas.style.width = `${options.w}px`;
  canvas.style.height = `${options.h}px`;

  // The context is created here rather than by `createViewport`, for two reasons, and
  // both of them are about being able to *read the answer*:
  //
  // - **`preserveDrawingBuffer`.** Without it the drawing buffer is discarded once the
  //   frame has been composited, so both `readPixels` and a screenshot taken a moment
  //   later return a black canvas — which is indistinguishable from a sky that drew
  //   nothing. rmsl's `WebGLRenderer` fixes the attributes at `antialias` and `depth`,
  //   and a second `getContext` call returns the context the first one made, so asking
  //   here is the only way to get this flag.
  // - **The loss event.** A software rasteriser under a heavy shader can lose the
  //   context mid-frame, and a lost context reads back as zeros. A black frame and a
  //   dead one are completely different findings, so the page says which it was.
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: true,
    preserveDrawingBuffer: true,
  });
  let lost = false;
  canvas.addEventListener("webglcontextlost", (event) => {
    lost = true;
    event.preventDefault();
  });

  if (options.compile && gl !== null) {
    readout.textContent = [
      `precision ${precision.ok ? precision.precision : precision.reason}`,
      ...compileReport(gl),
    ].join("\n");
    return;
  }

  const viewport = createViewport(canvas, {
    ...(precision.ok ? { precision: precision.precision } : {}),
  });
  viewport.setBackground(new Color(0, 0, 0));

  const state = dayNightState(options.t);
  const eye = new Vector3(0, 0, 0);
  const sky = createSky(viewport.scene);
  sky.update(eye, state);
  sky.material.pixelScale = viewport.pixelRatio;

  let clouds: Clouds | null = null;
  if (options.clouds) {
    clouds = createClouds(viewport.scene, 20260901, bakeCloudField(20260901));
    clouds.update(eye, state);
  }

  viewport.camera.position.set(0, 0, 0);
  viewport.camera.lookAt(
    0,
    Math.sin((options.elevation / 180) * Math.PI),
    -Math.cos((options.elevation / 180) * Math.PI),
  );

  // A red box in front of the eye, on the plainest material the library has, as a
  // control. If *this* is not in the frame then the framebuffer is not what this page
  // thinks it is, and no number below it means anything — which is worth being able to
  // say out loud rather than infer from a black rectangle.
  if (options.box) {
    const box = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ color: new Color(1, 0.2, 0.2) }),
    );
    box.position.set(0, 0, -30);
    viewport.scene.add(box);
  }

  viewport.render();

  // The frame twice: once with the layer in it and once without, so the difference is
  // the layer's own contribution and the sky's own brightness cannot hide it. A layer
  // that draws black into a bright sky looks like a bright frame with dark patches; the
  // two numbers are what tell that apart from a layer that is merely dim.
  let without = measure(viewport);
  if (clouds !== null) {
    clouds.dispose();
    viewport.render();
    without = measure(viewport);
  }

  const frame = measure(viewport);
  const context = lost
    ? "CONTEXT LOST — this frame says nothing about the sky"
    : `context alive (${gl?.getParameter(gl.VERSION) ?? "?"})`;
  const layer =
    clouds === null
      ? []
      : [
          "",
          `SKY ALONE: ${without.lit} lit · mean ${without.mean.toFixed(1)} · peak ${without.peak}`,
          `WITH LAYER: ${frame.lit} lit · mean ${frame.mean.toFixed(1)} · peak ${frame.peak}`,
          `THE LAYER'S OWN CONTRIBUTION: mean ${(frame.mean - without.mean).toFixed(1)} · peak ${frame.peak - without.peak}`,
        ];
  readout.textContent = [
    `precision ${precision.ok ? precision.precision : precision.reason} · pixel ratio ${viewport.pixelRatio} · ${context}`,
    describe(state, frame, clouds, viewport.pixelRatio),
    ...layer,
  ].join("\n");
};

try {
  run();
} catch (reason) {
  readout.textContent = `FAILED: ${
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  }`;
}
