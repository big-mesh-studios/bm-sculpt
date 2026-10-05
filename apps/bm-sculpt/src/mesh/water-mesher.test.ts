/**
 * The sea, as a field and as a mesh.
 *
 * ## What this file is for
 *
 * One bug, and it is the reason the sea is meshed at all. The sea used to be a sphere at the
 * planet's radius, so it was everywhere below that radius and the only reason a hole in the
 * ground did not show it was that the rock around the hole happened to be in front of it. **Dig
 * a shaft down through a hill, cross the radius inside the rock, and the shaft filled with
 * water to the bottom** — the shape of the sphere deciding where water was, rather than the
 * shape of the ground.
 *
 * Every test below is one of the ways that can be true or false, and they are checked against
 * the *pristine* landscape rather than an edited one, because that is the whole design: water is
 * a static sheet at sea level, cut to the world as it was generated.
 */

import { describe, expect, it } from "vitest";

import {
  baseFieldFor,
  DEFAULT_PLANET,
  isPlanetField,
  seaLevelOf,
} from "@big-mesh-studios/csg";
import type { BaseFieldSpec, BuiltBaseField } from "@big-mesh-studios/csg";
import { length, scale, vec3 } from "@big-mesh-studios/core";

import { chunkCellOf } from "../world";
import { VOXEL_SIZE } from "../constants";
import {
  couldHoldWater,
  outOfTheGround,
  seaDistanceOf,
  WATER_OVERLAP,
  WaterChunkMesher,
} from "./water-mesher";

/**
 * A planet small enough that its whole relief is a few chunks across.
 *
 * **Small on purpose.** The default planet is 136,000 units of radius with 288 units of relief,
 * so the sea's surface is nearly flat over any chunk a test could mesh and none of these cases
 * would arise. At 4,000 the relief is a twentieth of the radius, which is a planet with real
 * coasts, real seabed and real shoreline in a 320-unit chunk.
 */
const PLANET: BaseFieldSpec = {
  kind: "planet",
  params: { radius: 4000, scale: 96, octaves: 4, seed: 20260901 },
};

const planet = (): BuiltBaseField => {
  const field = baseFieldFor(PLANET);
  if (field === undefined) throw new Error("the planet did not build");
  return field;
};

/** The surface's radius in a direction, as a unit vector scaled to it. */
const atRadius = (direction: readonly [number, number, number], r: number) => {
  const d = vec3(...direction);
  return scale(d, r / length(d));
};

/** Calls a three-argument field at a point, so a test can read `sea(where(...))`. */
const fieldAt = (
  field: (x: number, y: number, z: number) => number,
  p: { x: number; y: number; z: number },
): number => field(p.x, p.y, p.z);

describe("the sea's field", () => {
  it("is zero at the landscape's own sea level", () => {
    // **The sea level is the landscape's number, not one passed in.** `BuiltBaseField.seaLevel`
    // exists so that the main thread, every worker and the mesher all read the same sea from the
    // same spec; a caller supplying its own would be one more place the water could be somewhere
    // other than where the ground says.
    expect(seaLevelOf(PLANET)).toBe(PLANET.params.radius);
    expect(planet().seaLevel).toBe(PLANET.params.radius);
    const sea = seaDistanceOf(planet());
    expect(fieldAt(sea, atRadius([1, 0, 0], 4000))).toBeCloseTo(0, 9);
  });

  it("is negative below the sea level and positive above it", () => {
    // **The sign is the mesher's whole contract.** `distance < 0` is inside the material, so
    // the water has to be the material: a point below the waterline is negative. A field that
    // read "distance to the surface" would put a sphere of air in the middle of the ocean and
    // nothing at all at its surface, and both would look like a bug in the mesher.
    const sea = seaDistanceOf(planet());
    expect(fieldAt(sea, atRadius([1, 0, 0], 3900))).toBeLessThan(0);
    expect(fieldAt(sea, atRadius([1, 0, 0], 4100))).toBeGreaterThan(0);
  });

  it("reads a height field's sea as an altitude", () => {
    // **Two worlds, and the one measurement that tells them apart.** A height field's sea is
    // flat, so its distance does not depend on `x` or `z` at all — where a planet's would.
    const flat = baseFieldFor({
      kind: "terrain",
      params: { origin: -70, scale: 96, octaves: 4, seed: 1 },
    });
    if (flat === undefined) throw new Error("the landscape did not build");
    const sea = seaDistanceOf(flat);
    expect(fieldAt(sea, vec3(0, -70, 0))).toBeCloseTo(0, 9);
    expect(fieldAt(sea, vec3(5000, -70, -9000))).toBeCloseTo(0, 9);
    expect(fieldAt(sea, vec3(0, -80, 0))).toBeLessThan(0);
  });
});

describe("the gate that stops the sea at the ground", () => {
  const marks = (...values: number[]): Float32Array =>
    Float32Array.from(values);

  const strict = outOfTheGround();
  const overlapping = outOfTheGround(WATER_OVERLAP);

  it("admits a cell with every corner out of the ground", () => {
    expect(strict(marks(0), marks(1, 1, 1, 1, 1, 1, 1, 1))).toBe(true);
  });

  it("refuses a cell with any corner in the ground", () => {
    // **Any, not all.** A cell holding one corner of rock is a cell the seabed passes through,
    // and the whole of the complaint was that the seabed was being drawn as water.
    expect(strict(marks(0), marks(1, 1, 1, 1, 1, 1, 1, -1))).toBe(false);
  });

  it("admits a corner exactly on the ground's surface", () => {
    // **`>= 0` rather than `> 0`, and this is why.** The alternative cuts the water a further
    // cell off every shore to exclude the case where a sample lands precisely on the rock, which
    // is a coincidence no real landscape produces and which the loose test would then be paying
    // for on every shore.
    expect(strict(marks(0), marks(0, 1, 1, 1, 1, 1, 1, 1))).toBe(true);
  });

  it("reaches a margin into the ground, and no further", () => {
    // **The gap at the shore.** The cell holding the shoreline always has a corner in the ground,
    // so the strict rule stops the sea up to a whole cell short of where the ground crosses the
    // water line — a strip of bare seabed along every beach. The margin closes it, and the water
    // it admits is inside the rock, where the beach's own depth hides it.
    expect(WATER_OVERLAP).toBeGreaterThan(0);
    // Just inside the margin: admitted, and this is the case the margin exists for.
    expect(
      overlapping(marks(0), marks(1, 1, 1, 1, 1, 1, 1, -WATER_OVERLAP + 1e-3)),
    ).toBe(true);
    // Just outside it: refused, so the sea bed is still not drawn as water. The margin is
    // measured against the *ground's* distance, not the cell's size, so a steep shore is not
    // opened to the sea by a shallow one somewhere else on the planet.
    expect(
      overlapping(marks(0), marks(1, 1, 1, 1, 1, 1, 1, -WATER_OVERLAP - 1e-3)),
    ).toBe(false);
  });

  it("is two finest voxels, which is what it takes to reach past the shoreline", () => {
    // **The number is derived from the mesher's own resolution rather than chosen, and it is two
    // of them rather than one because one is not enough.** The gap is not a cell wide: the gate
    // decides on a corner's *depth*, so on a gentle shore the sea's edge stops far short of the
    // water line. Measured on a 1:10 beach — no margin, 105 units short; one voxel, 5 short; two,
    // past it. `water-mesher.test.ts` holds the reason a larger margin is still safe.
    expect(WATER_OVERLAP).toBe(2 * VOXEL_SIZE);
  });
});

describe("the chunk gate", () => {
  /**
   * A cube of `half` about a point, as the chunks around a point on the equator are.
   *
   * **An axis-aligned box near the `x` axis**, because that is where the radius range of a cube
   * is close to its own side length: a cube *at* the origin has a radius range of `0` to `r√3`,
   * so a box placed at 3900 to 4100 on every axis is nowhere near the sea at all. The gate is
   * about distance from the centre, and a test that placed its box diagonally would be testing
   * the wrong number.
   */
  const about = (centre: number, half = 100) => ({
    min: { x: centre - half, y: -half, z: -half },
    max: { x: centre + half, y: half, z: half },
  });

  it("rules out a box that misses the sea level entirely", () => {
    // **The cheap half of streaming, and on a planet most of it.** Deep rock and high sky are
    // answered by a radius range rather than by 34,304 samples each.
    const built = planet();
    expect(couldHoldWater(built, about(3000))).toBe(false);
    expect(couldHoldWater(built, about(4800))).toBe(false);
  });

  it("keeps a box that straddles the sea level", () => {
    const built = planet();
    expect(couldHoldWater(built, about(4000))).toBe(true);
  });

  it("does not rule out a box whose face lands exactly on the sea level", () => {
    // **Conservative in one direction only**, and the same rule `couldHoldSurface` follows: a box
    // whose face *is* the surface must not be skipped, or the sea drops a surface on the seam
    // with nothing to re-mesh it.
    const built = planet();
    expect(couldHoldWater(built, about(4100, 100))).toBe(true);
    expect(couldHoldWater(built, about(3900, 100))).toBe(true);
  });

  it("reads a height field's sea as one altitude comparison", () => {
    const flat = baseFieldFor({
      kind: "terrain",
      params: { origin: -70, scale: 96, octaves: 4, seed: 1 },
    });
    if (flat === undefined) throw new Error("the landscape did not build");
    const box = (minY: number, maxY: number) => ({
      min: { x: -100, y: minY, z: -100 },
      max: { x: 100, y: maxY, z: 100 },
    });
    expect(couldHoldWater(flat, box(0, 100))).toBe(false);
    expect(couldHoldWater(flat, box(-200, -150))).toBe(false);
    expect(couldHoldWater(flat, box(-100, 0))).toBe(true);
    expect(couldHoldWater(flat, box(-70, 100))).toBe(true);
  });
});

/**
 * A landscape built for the test, because the mesher's only input is a field.
 *
 * **A step, not noise.** The claims below are about where the sea is drawn relative to the
 * ground, and a noise landscape makes every one of them a statement about a particular seed as
 * well — which is a claim nobody can check by reading it. This field has a **basin** whose floor
 * is a hundred units below the sea level and a **plateau** a hundred units above it, so the
 * coast is a circle and the difference between the two halves is exact.
 *
 * The two surfaces are what the mesher has: `seaLevel` and a distance. Everything else — the
 * player, a shaft dug through the plateau, a pit dug in the basin floor — is in the *model*,
 * and **the water mesher never sees the model at all.** That is the point being tested, and it
 * is why a synthetic field is the right bed for it: nothing else about the field has to be true.
 */
const landscape = (): BuiltBaseField => {
  const seaLevel = 0;
  const floor = -100;
  const plateau = 100;
  const basin = 260;
  const groundAt = (x: number, z: number): number =>
    Math.hypot(x, z) < basin ? floor : plateau;
  const distance = (x: number, y: number, z: number): number =>
    y - groundAt(x, z);
  return Object.assign(distance, {
    kind: "terrain" as const,
    seaLevel,
    lipschitz: 1,
    heightAt: groundAt,
    lowest: floor,
    highest: plateau,
    fallbackNormal: () => vec3(0, 1, 0),
    couldHoldSurface: () => true,
  });
};

describe("a chunk, meshed as water", () => {
  /** A chunk on the basin's floor, where the sea is over open ground. */
  const inTheBasin = { x: 0, y: 0, z: 0 };
  /** A chunk on the plateau, where the sea level is inside rock. */
  const onThePlateau = { x: 4, y: 0, z: 4 };

  it("meshes a sea over ground that is below the sea level", () => {
    const mesher = new WaterChunkMesher(landscape());
    const mesh = mesher.mesh({ cell: inTheBasin, lod: 0 });
    expect(mesh.vertexCount).toBeGreaterThan(0);

    // **Every vertex exactly on the waterline.** The sea's surface is a plane at `seaLevel` and
    // nothing else — not the ground's surface, not a blend, and not the model's. A vertex at
    // another altitude means the mesher is drawing something else.
    for (let v = 0; v < mesh.vertexCount; v++) {
      expect(mesh.positions[v * 3 + 1]).toBeCloseTo(0, 1);
    }
    // And the gate keeps it: this chunk's extent crosses the sea level.
    expect(mesher.couldHaveMesh?.(inTheBasin, 0)).toBe(true);
  });

  it("draws nothing where the ground is above the sea level", () => {
    // **The shaft case, and it is worth being precise about why.** A shaft dug down through the
    // plateau crosses the sea level *inside the hill*. The player's dig changes the model; the
    // water mesher reads the landscape, which is unmoved — so there is no sea there to fall into,
    // and the shaft is dry.
    //
    // **The thing this replaces:** a sea drawn as a sphere was everywhere below the radius, and
    // the only reason that shaft did not fill was that the rock around it happened to be in
    // front of the sphere. Cross the radius inside the hill and the sphere crossed the shaft.
    const mesher = new WaterChunkMesher(landscape());
    const mesh = mesher.mesh({ cell: onThePlateau, lod: 0 });
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.triangleCount).toBe(0);
  });

  it("does not draw a sea inside a hill, even where the chunk straddles the sea level", () => {
    // **The gate cannot rule this chunk out, and must not.** Its extent does contain `seaLevel`,
    // so `couldHoldWater` admits it and the samples have to do the work. A gate that answered
    // "no water" here on a radius range alone would be right by accident and wrong the moment
    // the chunk's own extent straddled the shore.
    const mesher = new WaterChunkMesher(landscape());
    expect(mesher.couldHaveMesh?.(onThePlateau, 0)).toBe(true);
    expect(mesher.mesh({ cell: onThePlateau, lod: 0 }).vertexCount).toBe(0);
  });

  it("keeps the sea a sheet above a hole dug in the seabed", () => {
    // **The other half of the decision, and the one a person notices.** Water is static: a pit
    // dug into the basin's floor sits under a landscape that was already underwater, so the
    // sea's surface stays where it was and the pit is dry air beneath it. Nothing here models a
    // pit — the point is that *not modelling it* is the behaviour, because the sea is gated on
    // the landscape and a dig is a change to the model.
    //
    // Asserted as "every vertex is on the waterline", which is the same claim as "no surface
    // follows the hole down" and is checkable from the mesh alone.
    const mesher = new WaterChunkMesher(landscape());
    const mesh = mesher.mesh({ cell: inTheBasin, lod: 0 });
    for (let v = 0; v < mesh.vertexCount; v++)
      expect(mesh.positions[v * 3 + 1]).toBeCloseTo(0, 1);
  });

  it("draws the sea where the coast is, and stops at the shore", () => {
    // **A chunk that straddles the coastline is the interesting one**: part of it is over the
    // basin and part of it is over the plateau, and the sea has to end where the ground rises
    // through it. The cell that holds the coast is refused — it has corners in the ground — so
    // the sea stops up to one cell short of the true waterline, which reads as shallows.
    const mesher = new WaterChunkMesher(landscape());
    const mesh = mesher.mesh({ cell: { x: 0, y: 0, z: 1 }, lod: 0 });
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = mesh.positions[v * 3]!;
      const z = mesh.positions[v * 3 + 2]!;
      // Every vertex is on the waterline, and **out of the ground**: a vertex inside the plateau
      // would be a sea drawn through a hill, which is the failure in its purest form.
      expect(mesh.positions[v * 3 + 1]).toBeCloseTo(0, 1);
      const ground = Math.hypot(x, z) < 260 ? -100 : 100;
      expect(ground).toBeLessThan(0);
    }
  });

  it("never puts a water vertex above the ground", () => {
    // **The invariant the whole overlap rests on, and the reason it is safe.** The sea's surface
    // is at the sea level and nothing else, so wherever the ground stands above the sea level a
    // water vertex is *inside* the land — which is what closes the gap at the shore, and what
    // means the extra water is buried rather than a film of it laid over the beach.
    //
    // A vertex above the ground would be the failure: water floating over a hillside, or a sheet
    // drawn across a beach. The margin cannot cause it — the field is unchanged, and a vertex is
    // still placed where the sea's surface crosses zero — so this is a check that the gate admits
    // only cells that are *buried* rather than cells that are merely *near* the sea.
    //
    // Measured over three gradients of beach, because the margin buys more reach the gentler the
    // shore and a steeper one is where a gate admitting "near" instead of "under" would show.
    for (const rise of [0.05, 0.2, 1]) {
      const field = Object.assign(
        (x: number, y: number, _z: number) => y - x * rise,
        {
          kind: "terrain" as const,
          seaLevel: 0,
          lipschitz: 1,
          heightAt: (x: number) => x * rise,
          lowest: -2000,
          highest: 2000,
          fallbackNormal: () => vec3(0, 1, 0),
          couldHoldSurface: () => true,
        },
      );
      const mesher = new WaterChunkMesher(field);
      // A run of chunks across the shoreline, so the overlap region is well covered.
      let vertices = 0;
      let overlapped = 0;
      for (const cx of [-2, -1, 0, 1]) {
        const mesh = mesher.mesh({ cell: { x: cx, y: 0, z: 0 }, lod: 0 });
        vertices += mesh.vertexCount;
        for (let v = 0; v < mesh.vertexCount; v++) {
          const x = mesh.positions[v * 3]!;
          const y = mesh.positions[v * 3 + 1]!;
          const ground = field.heightAt(x);
          // **Two claims, and which one applies is decided by the ground.** Over the sea the
          // water is above the sea floor — that is what water is — and on land it must be
          // *buried*, which is the whole of the overlap's safety. Asserting the first everywhere
          // would be asserting nothing, and asserting the second everywhere would be wrong.
          if (ground > 0) {
            overlapped++;
            // Strictly under: a vertex sitting exactly on the rock is a sheet drawn across the
            // shore, which is the thing the margin must never produce.
            expect(y, `rise ${rise} at x ${x}, ground ${ground}`).toBeLessThan(
              ground,
            );
          } else {
            expect(
              y,
              `rise ${rise} at x ${x}, ground ${ground}`,
            ).toBeGreaterThan(ground);
          }
        }
      }
      // **Some of the overlap was actually exercised**, or the check above is vacuous — a gate
      // that refused everything would also never put a vertex above the ground.
      expect(vertices, `rise ${rise}`).toBeGreaterThan(0);
      expect(
        overlapped,
        `rise ${rise}: water reached past the shoreline`,
      ).toBeGreaterThan(0);
    }
  });

  it("carries a normal and a colour, because the layout is shared", () => {
    // **Neither is read.** The sea material takes its normal from the sphere's centre per
    // fragment, which is what makes a meshed sea smooth at any tessellation. The buffers are
    // written because `ChunkMeshBuilder` will not take a vertex without them and the water
    // chunks share the ground's geometry pipeline.
    const mesh = new WaterChunkMesher(landscape()).mesh({
      cell: inTheBasin,
      lod: 0,
    });
    expect(mesh.normalOct.length).toBe(mesh.vertexCount * 2);
    expect(mesh.colours.length).toBe(mesh.vertexCount * 4);
    for (let v = 0; v < mesh.vertexCount; v++)
      expect(mesh.colours[v * 4 + 3]).toBe(255);
  });

  it("reuses one buffer for a second chunk without leaking between them", () => {
    // **The mesher holds its builder for its whole life**, which is the whole of why it can be
    // reused at all; a leftover vertex from the previous chunk would be drawn at this one's
    // coordinates.
    const mesher = new WaterChunkMesher(landscape());
    const first = mesher.mesh({ cell: inTheBasin, lod: 0 });
    const second = mesher.mesh({ cell: onThePlateau, lod: 0 });
    expect(first.vertexCount).toBeGreaterThan(0);
    expect(second.vertexCount).toBe(0);

    const third = mesher.mesh({ cell: inTheBasin, lod: 0 });
    expect(third.vertexCount).toBe(first.vertexCount);
    expect([...third.indices]).toEqual([...first.indices]);
  });
});

describe("the shipped planet, meshed as water", () => {
  it("puts every water vertex on the sea radius", () => {
    // **End to end on the real field**: the sphere's radius, the landscape's own noise, and the
    // gate. The direction is found by asking the field rather than hard-coded, because this
    // planet's surface is mostly above its own sea radius and the one stretch of ocean moves
    // with the seed.
    const built = baseFieldFor(PLANET);
    if (built === undefined || !isPlanetField(built))
      throw new Error("the planet did not build as a planet");
    const mesher = new WaterChunkMesher(built);

    let found: { x: number; y: number; z: number } | undefined;
    for (let i = 0; i < 64 && found === undefined; i++) {
      const theta = (Math.PI * i) / 64;
      for (let j = 0; j < 64 && found === undefined; j++) {
        const phi = (2 * Math.PI * j) / 64;
        const direction = vec3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        );
        if (built.radiusAt(direction) < 4000 - 10)
          found = scale(direction, 4000);
      }
    }
    expect(found, "found an ocean on the shipped planet").toBeDefined();

    const mesh = mesher.mesh({ cell: chunkCellOf(found!), lod: 0 });
    expect(mesh.vertexCount).toBeGreaterThan(0);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const r = Math.hypot(
        mesh.positions[v * 3]!,
        mesh.positions[v * 3 + 1]!,
        mesh.positions[v * 3 + 2]!,
      );
      expect(r).toBeCloseTo(4000, 0);
    }
  });
});

describe("the default planet's sea", () => {
  it("is the radius, and not the radius minus the height field's origin", () => {
    // **Kept from the deleted sea-sphere's tests, because the number did not change and the
    // mistake it guards against did not either.** `origin` on a height field is the altitude its
    // height of zero sits at; a sphere has no height of zero, so the sea goes at `radius`.
    // Subtracting 70 puts it beneath the lowest land on this planet and yields a dry world.
    const shipped = baseFieldFor({
      kind: "planet",
      params: DEFAULT_PLANET,
    });
    if (shipped === undefined)
      throw new Error("the shipped planet did not build");
    expect(shipped.seaLevel).toBe(DEFAULT_PLANET.radius);
    expect(shipped.seaLevel).not.toBe(DEFAULT_PLANET.radius - 70);
  });
});
