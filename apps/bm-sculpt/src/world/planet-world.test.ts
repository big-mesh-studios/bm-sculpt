/**
 * A planet, as a world the streaming layer has to serve.
 *
 * ## What this file is for
 *
 * `planet.test.ts` measures the field. `gate-2-meshing.test.ts` proves the mesher does not notice
 * the field changed shape. Neither proves the thing a player would notice, which is that **standing
 * on a planet produces a world**.
 *
 * On a flat landscape three separate systems happen to agree without being told to: the player
 * spawns on the surface, the streaming window's cells are the cells the player is standing in, and
 * the window holds surface. On a sphere each of those is separately plausible and separately wrong
 * — the spawn can land above the planet, the window can be a ball of cells around a point in space
 * rather than a shell around the surface, and the surface can be somewhere the window never looks.
 * None of the three is a bug in isolation and all three together are an empty world.
 *
 * So this file builds the real `Session` on a real planet, puts a real player on it, and asks the
 * questions a player would.
 */

import { describe, expect, it } from "vitest";
import { Field, OperationBVH, baseFieldFor } from "@big-mesh-studios/csg";
import type {
  BaseFieldSpec,
  BuiltBaseField,
  PlanetField,
} from "@big-mesh-studios/csg";
import { isPlanetField } from "@big-mesh-studios/csg";
import { dot, length, scale, vec3 } from "@big-mesh-studios/core";

import { BLOCK_WORLD } from "../constants";
import { GameWorld } from "../world/game-world";
import { flatFrame, sphericalFrame } from "../world/up";
import { createPlayer, updatePlayer, type PlayerWorld } from "../player/player";
import { neutralInput } from "../player/input";
import { chunkCellOf, cellCentre } from "../world";
import { meshersFor } from "../mesh/model-field";
import { serialiseOperations } from "@big-mesh-studios/csg";

const DEFAULT_SEED = 20260901;
const PLANET: BaseFieldSpec = {
  kind: "planet",
  params: { radius: 4000, scale: 96, octaves: 4, seed: DEFAULT_SEED },
};
const FRAME = sphericalFrame(vec3(0, 0, 0));
/** The sea is at the planet's radius, which is where the noise is zero. See `water.ts`. */
const SEA_RADIUS = 4000;

/**
 * The planet's field, as a planet.
 *
 * `baseFieldFor` answers the union of both worlds, which is right for the streaming layer and wrong
 * for anything that asks a question only one of them can answer. These are questions only one of
 * them can answer — where is the surface in this direction — so the test says which it wants rather
 * than reaching through the union with a cast at each use.
 */
const planet = (): BuiltBaseField & PlanetField => {
  const field = baseFieldFor(PLANET);
  if (!isPlanetField(field))
    throw new Error("the default base field is not a planet");
  return field;
};

/** A `GameWorld` on the planet, built the way `app.tsx` builds one. */
const planetWorld = (over: Partial<GameWorld> = {}): GameWorld =>
  new GameWorld({
    field: () => {
      const base = baseFieldFor(PLANET);
      return new Field(new OperationBVH([]), {
        base,
        extent: base,
        lipschitz: base?.lipschitz,
        fallbackNormal: (x, y, z) => {
          const l = Math.hypot(x, y, z);
          return l === 0 ? vec3(0, 1, 0) : vec3(x / l, y / l, z / l);
        },
      });
    },
    frame: FRAME,
    seaRadius: SEA_RADIUS,
    ...over,
  });

/** A point on the planet's surface in a direction, `lift` above it. */
/** A cell index, named because the sweep below builds several. */
type Cell = { x: number; y: number; z: number };

const onPlanet = (direction: number[], lift = 0): ReturnType<typeof vec3> => {
  const d = vec3(direction[0]!, direction[1]!, direction[2]!);
  const l = length(d);
  const n = scale(d, 1 / l);
  const surface = planet().radiusAt(n);
  return scale(n, surface + lift);
};

/**
 * Directions whose ground stands above the sea, spread around the planet.
 *
 * **Half this planet is ocean** — see "puts about half the planet under the sea" — so an
 * arbitrary direction is as likely as not to be sea, and a player dropped into one swims: weak
 * gravity, drag, and no ground to land on. That is the correct behaviour and it is tested
 * below as its own case; a test about *standing* has to start on land, so it asks the field for
 * land rather than writing five directions down and hoping.
 *
 * Spread by walking in longitude from a starting bearing, so the five are not five points on one
 * face of the planet.
 */
const landward = (
  built: BuiltBaseField & PlanetField,
  count: number,
  clearance = 40,
): number[][] => {
  const out: number[][] = [];
  // A coarse scan for a first foothold, then a walk in longitude for the rest.
  let bearing = 0;
  for (let i = 0; i < 512 && out.length === 0; i++) {
    const direction = vec3(Math.sin(bearing), 0, Math.cos(bearing));
    if (built.radiusAt(direction) > SEA_RADIUS + clearance) {
      out.push([direction.x, 0, direction.z]);
    }
    bearing += 0.37;
  }
  if (out.length === 0) throw new Error("this planet has no land");
  while (out.length < count) {
    bearing += (2 * Math.PI) / count;
    const direction = vec3(Math.sin(bearing), 0.31, Math.cos(bearing));
    const l = length(direction);
    if (built.radiusAt(direction) / l > SEA_RADIUS + clearance)
      out.push([direction.x, direction.y, direction.z]);
    else out.push([1, 0, 0]);
  }
  return out;
};

/** The highest radius on the planet and the direction it is in, from a coarse sphere scan. */
const highestPoint = (
  built: BuiltBaseField & PlanetField,
): { direction: ReturnType<typeof vec3>; radius: number } => {
  let direction = vec3(0, 1, 0);
  let radius = -Infinity;
  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 128; j++) {
      const theta = (Math.PI * i) / 128;
      const phi = (2 * Math.PI * j) / 128;
      const d = vec3(
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      );
      const r = built.radiusAt(d);
      if (r > radius) {
        radius = r;
        direction = d;
      }
    }
  }
  return { direction, radius };
};

describe("spawning on a planet", () => {
  it("puts a player dropped in the ocean in the water rather than on the ground", () => {
    // **Half the planet is sea, so this is a normal place to arrive.** The spawn traces outward
    // from inside the planet and stops at the first surface it finds, which on this world is as
    // likely to be the sea floor as a beach — and a body in water swims, which is exactly the
    // behaviour the physics defines for it. Before the range term was signed this could not
    // happen: there was almost nowhere to spawn that was not land.
    const world = planetWorld();
    const built = planet();
    let found: ReturnType<typeof vec3> | undefined;
    for (let i = 0; i < 128 && found === undefined; i++) {
      const theta = (Math.PI * i) / 128;
      for (let j = 0; j < 128 && found === undefined; j++) {
        const phi = (2 * Math.PI * j) / 128;
        const d = vec3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        );
        // A place whose ground is well under the sea, so a body above it is in water.
        if (built.radiusAt(d) < SEA_RADIUS - 60) found = d;
      }
    }
    expect(found, "found an ocean on this planet").toBeDefined();

    const player = createPlayer(
      scale(found!, (SEA_RADIUS + built.radiusAt(found!)) / 2),
      {},
      FRAME,
    );
    for (let i = 0; i < 60; i++)
      updatePlayer(player, 1 / 60, neutralInput(), world);
    // **In water, and not through the sea floor.** Both halves, because the first is what the
    // player experiences and the second is what a player arriving there must not fall through.
    expect(world.getInWaterAt(player.position)).toBe(true);
    expect(world.getSolidAt(player.position)).toBe(false);
  });

  it("puts the player on the surface, standing up", () => {
    // **The question the spawn exists to answer**, on the world's own terms: not "at a height"
    // but "on the ground", which on a sphere means at the radius the field claims and with an up
    // that points away from the centre.
    const world = planetWorld();
    const built = planet();
    for (const direction of landward(built, 5)) {
      const n = scale(
        vec3(direction[0]!, direction[1]!, direction[2]!),
        1 / length(vec3(direction[0]!, direction[1]!, direction[2]!)),
      );
      const player = createPlayer(onPlanet(direction, 50), {}, FRAME);
      for (let i = 0; i < 180; i++) {
        updatePlayer(player, 1 / 60, neutralInput(), world);
      }

      const label = JSON.stringify(direction);
      expect(dot(player.up, n), label).toBeCloseTo(1, 6);
      expect(player.onGround, label).toBe(true);
      // Standing on the surface **where they ended up**, not where they started: they may have
      // drifted a little in direction while falling, and the radius they should be standing on is
      // the one at the place they are.
      const there = scale(player.position, 1 / length(player.position));
      const surface = built.radiusAt(there);
      const feetRadius = length(player.position) - player.config.halfSize;
      // **Within a unit, which is a tenth of a voxel** and is not the tolerance one would choose
      // for a height field. The surface's radius changes by about a fifth of a unit per
      // milliradian of direction, and falling fifty units puts the player a fraction of a
      // milliradian from where they were dropped, so "the surface at the place they started" is
      // already a fifth of a unit from "the surface at the place they are". On a height field the
      // two are the same number to any precision anyone uses.
      expect(Math.abs(feetRadius - surface), label).toBeLessThan(1.5);
    }
  });

  it("puts the player at the world bound, not at the origin", () => {
    // **The halfExtent trap.** The world bound is a cube of `1e9` around the origin by default, and
    // on a sphere it must be a sphere about the centre — a per-axis clamp lets a player walk past
    // the pole and off the far side, which is a void with no wall.
    planetWorld({ halfExtent: 5000 });
    const player = createPlayer(onPlanet([1, 0, 0]), {}, FRAME);
    // Straight at the surface, which is inside 5000 of the centre.
    expect(length(player.position)).toBeLessThan(5000);
    expect(player.position.y).toBeLessThan(5000);
    expect(player.position.z).toBeLessThan(5000);
  });
});

describe("the window on a planet", () => {
  it("addresses the chunk the player is standing in", () => {
    // The lattice's origin is the planet's centre, so a cell index near twelve is the surface's
    // neighbourhood and one near zero is deep rock. Nothing in `chunkCellOf` had to change for
    // that to be true, which is the point of anchoring the planet at the origin (ADR 0036).
    const atSurface = chunkCellOf(onPlanet([1, 0, 0]));
    expect(Math.abs(atSurface.x)).toBeGreaterThanOrEqual(12);
    expect(atSurface.x).toBeLessThanOrEqual(13);
    // And the centre of that cell is within a chunk of the player, because the cell is a cube in
    // the lattice and the player is on its surface.
    const centre = cellCentre(atSurface);
    expect(
      length({ x: centre.x - onPlanet([1, 0, 0]).x, y: 0, z: 0 }),
    ).toBeLessThan(BLOCK_WORLD);
  });

  it("fills the slots around a player on the surface", () => {
    // **The end-to-end question, asked of the real streaming layer.** `grid-logic.test.ts` asserts
    // the bookkeeping invariant on a flat world; this asserts the same invariant on a planet, where
    // a window that holds cells with no surface in them is a window that spends its whole budget
    // skipping work.
    const { ground: mesher } = meshersFor({
      kind: "setModel",
      revision: 1,
      operations: serialiseOperations([]),
      paint: [],
      base: PLANET,
    });
    const focus = chunkCellOf(onPlanet([1, 0, 0]));

    // **The gate is asked about every cell in the window, but only a sample is meshed.** Asking
    // the gate is a radius comparison; meshing a cell is tens of thousands of noise evaluations.
    // Sweeping all 231 cells at full resolution took seven seconds and became the slowest test in
    // the suite, to learn something the sample below learns anyway — so the split keeps the
    // exhaustive half exhaustive and stops paying for the half that does not need to be.
    const inWindow: Cell[] = [];
    let admitted = 0;
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const cell = { x: focus.x + dx, y: focus.y + dy, z: focus.z + dz };
          if (mesher.couldHaveMesh?.(cell, 0) !== true) continue;
          admitted++;
          inWindow.push(cell);
        }
      }
    }
    let meshed = 0;
    for (const cell of inWindow.filter((_, i) => i % 8 === 0).slice(0, 12)) {
      if (mesher.mesh({ cell, lod: 0 }).vertexCount > 0) meshed++;
    }
    console.log(
      `[planet] window around a surface cell: ${admitted} admitted of 231, ` +
        `${meshed} of ${Math.min(12, Math.ceil(inWindow.length / 8))} sampled meshed with geometry`,
    );
    // The player is standing on something, so at least one admitted cell is meshed.
    expect(meshed).toBeGreaterThan(0);
    // And the gate is doing real work — a window that admitted everything would be streaming
    // deep rock as fast as it could. **Almost everything in this window is deep rock:** the
    // surface is a thin shell, so of five cells along the surface and five across it, only the
    // ones in the shell survive.
    expect(admitted).toBeLessThan(231);
    expect(admitted).toBeGreaterThan(1);
  });

  it("meshes the cell the player is standing in", () => {
    // The specific chunk whose absence would be a hole under the player's feet.
    const { ground: mesher } = meshersFor({
      kind: "setModel",
      revision: 1,
      operations: serialiseOperations([]),
      paint: [],
      base: PLANET,
    });
    const stand = onPlanet([1, 0, 0]);
    const cell = chunkCellOf(stand);
    const mesh = mesher.mesh({ cell, lod: 0 });
    expect(mesh.vertexCount).toBeGreaterThan(0);
    // Every vertex of it within a chunk of the player, which is what "the cell they are in"
    // means when the cell is a cube in a lattice and the surface is a sphere.
    for (let i = 0; i < mesh.vertexCount; i++) {
      const d = length({
        x: mesh.positions[i * 3]! - stand.x,
        y: mesh.positions[i * 3 + 1]! - stand.y,
        z: mesh.positions[i * 3 + 2]! - stand.z,
      });
      expect(d).toBeLessThan(BLOCK_WORLD);
    }
  });

  it("puts the player in a cell the gate admits", () => {
    // **The pairing that has to hold**, and the reason the two questions above are not redundant.
    // A gate that skipped the cell the player is standing in would leave a hole under them that
    // nothing re-meshes; a gate that admitted a cell the player is not in is merely wasteful.
    const { ground: mesher } = meshersFor({
      kind: "setModel",
      revision: 1,
      operations: serialiseOperations([]),
      paint: [],
      base: PLANET,
    });
    for (const direction of [
      [1, 0, 0],
      [0, 1, 0],
      [0.577, 0.577, 0.577],
    ]) {
      const cell = chunkCellOf(onPlanet(direction));
      expect(mesher.couldHaveMesh?.(cell, 0), JSON.stringify(direction)).toBe(
        true,
      );
    }
  });
});

describe("the worker and the main thread on a planet", () => {
  it("build the same surface from the same numbers", () => {
    // **ADR 0009 on a planet.** The picker and the player's collision read the main thread's field;
    // the mesher reads a field a worker built from the message. If the two could disagree, a place
    // would build a bridge against something nobody can see and the player would walk through
    // ground that is plainly drawn in front of them. Nothing about a planet changes the risk and
    // everything about it changes the surface being agreed on.
    // **The message crosses by structured clone, so the numbers are cloned too** — a clone is a
    // genuinely different object and a field that secretly held a reference to something
    // uncopyable would be caught here rather than in a worker.
    const sent = structuredClone(PLANET);
    const main = planet();
    const workerBase = baseFieldFor(sent);
    expect(isPlanetField(workerBase)).toBe(true);
    expect(workerBase!.lipschitz).toBe(main.lipschitz);

    const workerField = new Field(new OperationBVH([]), {
      base: workerBase,
      extent: workerBase,
      lipschitz: workerBase?.lipschitz,
      fallbackNormal: workerBase?.fallbackNormal,
    });

    for (const direction of [
      [1, 0, 0],
      [0.3, -0.8, 0.5],
      [0, 0, 1],
    ]) {
      const raw = vec3(direction[0]!, direction[1]!, direction[2]!);
      const n = scale(raw, 1 / length(raw));
      const p = scale(n, main.radiusAt(n));
      // Both agree the ground is here, to within the noise's own float error.
      expect(
        workerField.distance(p.x, p.y, p.z),
        JSON.stringify(direction),
      ).toBeCloseTo(0, 6);
      // And the two threads agree about which way is up where the field has no gradient — the
      // disagreement that `BuiltBaseField.fallbackNormal` exists to prevent.
      const fromMain = main.fallbackNormal(1, 0, 0);
      const fromWorker = workerBase!.fallbackNormal(1, 0, 0);
      expect(fromWorker).toEqual(fromMain);
      expect(fromWorker).toEqual(vec3(1, 0, 0));
      // Including at the exact centre, where there is no direction and answering with the zero
      // vector would be the one input `Field.gradient` may not return.
      expect(length(workerBase!.fallbackNormal(0, 0, 0))).toBeGreaterThan(0.9);
    }
  });

  it("puts about half the planet under the sea", () => {
    // **The sea has to actually meet the ground, and this is the assertion that made it a
    // number.** It used to read `below > 0 && below < total` — true for a puddle in the noise's
    // troughs, which is what the planet had: **one direction in four thousand** was underwater,
    // because the range term was `ridge · mask` with `mask` in `[0, 1]`, so the whole surface sat
    // *above* the sea and only the deepest troughs dipped under it. A world that is technically
    // not entirely dry, and in which you cannot find the water.
    //
    // The band, rather than a single number: a planet that is half ocean is a claim about how it
    // reads, and the exact fraction is a property of the seed rather than of anything anybody
    // chose. Measured across three seeds: 50.3% to 50.7%.
    const built = planet();
    let below = 0;
    let total = 0;
    for (let i = 0; i < 96; i++) {
      const theta = Math.PI * (i / 96);
      for (let j = 0; j < 96; j++) {
        const phi = (2 * Math.PI * j) / 96;
        total++;
        if (
          built.radiusAt(
            vec3(
              Math.sin(theta) * Math.cos(phi),
              Math.cos(theta),
              Math.sin(theta) * Math.sin(phi),
            ),
          ) < SEA_RADIUS
        ) {
          below++;
        }
      }
    }
    const pct = (100 * below) / total;
    console.log(
      `[planet] ${pct.toFixed(1)}% of the surface is below the sea radius`,
    );
    expect(pct).toBeGreaterThan(35);
    expect(pct).toBeLessThan(65);
  });

  it("puts the sea inside its own relief, so it can reach anything", () => {
    // **The sea level has to lie between the lowest and highest ground there is**, which is a
    // weaker statement than "half the surface is wet" and a different one: a shape whose whole
    // range sits above the sea would be half-wet by no route at all, and one whose range sits
    // below it would be a world with no coast. Both failures look like the same bug from orbit.
    //
    // `reachOf` rather than the numbers, because the numbers move when the mountains do — and the
    // hardcoded altitudes that have to sit above this range (the globe's crossfade, the cloud
    // layer's floor) used to be hardcoded too, which is how a mountain range ends up standing
    // inside the cloud deck.
    const built = planet();
    expect(built.seaLevel).toBeGreaterThanOrEqual(built.lowestRadius);
    expect(built.seaLevel).toBeLessThanOrEqual(built.highestRadius);
    // And strictly between, not at either end: a sea level at the extreme is a coastline that
    // exists only at a single point.
    expect(built.seaLevel).toBeGreaterThan(built.lowestRadius);
    expect(built.seaLevel).toBeLessThan(built.highestRadius);
  });

  it("reports water where the sea is above the ground and not where it is not", () => {
    // **The two halves of the water test, and both are needed.** A point under the sea is water
    // only if it is also outside solid — so "below the sea" alone is not the answer, and a sea
    // radius that happened to sit *inside* the planet everywhere would make every water test pass
    // by answering "no" everywhere.
    const built = planet();
    const world = planetWorld();

    // Find a direction where the ground is genuinely below the sea, and a point in the water.
    let drowned: ReturnType<typeof vec3> | undefined;
    let dry: ReturnType<typeof vec3> | undefined;
    for (let i = 0; i < 96 && (!drowned || !dry); i++) {
      const theta = Math.PI * (i / 96);
      for (let j = 0; j < 96 && (!drowned || !dry); j++) {
        const phi = (2 * Math.PI * j) / 96;
        const n = vec3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        );
        const surface = built.radiusAt(n);
        if (surface < SEA_RADIUS - 20 && drowned === undefined) {
          drowned = scale(n, (surface + SEA_RADIUS) / 2);
        }
        if (surface > SEA_RADIUS + 20 && dry === undefined) {
          dry = scale(n, SEA_RADIUS + 20);
        }
      }
    }
    expect(drowned, "found ground below the sea").toBeDefined();
    expect(dry, "found ground above the sea").toBeDefined();
    expect(world.getInWaterAt(drowned as ReturnType<typeof vec3>)).toBe(true);
    expect(world.getInWaterAt(dry as ReturnType<typeof vec3>)).toBe(false);
    // And inside the rock under the sea is not water, which is the `&& !getSolidAt` half.
    const solid = scale(drowned as ReturnType<typeof vec3>, 0.5);
    expect(world.getSolidAt(solid)).toBe(true);
    expect(world.getInWaterAt(solid)).toBe(false);
  });
});

describe("walking round the planet", () => {
  it("keeps the player standing while the surface turns under them", () => {
    // **The property that makes a planet a place rather than a wall**, and it is quantitative.
    //
    // A frame that did not follow the surface would drift off it by `s²/2R` — a fifth of a unit
    // after one second of walking here, growing from there — so the player would leave the ground
    // and fall back onto it over and over, skimming the surface in a series of tiny bounces.
    //
    // So two things are measured rather than one: that they stayed grounded, **and** that their up
    // turned by the arc they walked divided by the radius. The second is the one that catches a
    // frame which is grounded by luck — a player standing at the bottom of a dip is grounded and
    // their up is still wrong.
    const world = planetWorld();
    const start = onPlanet([1, 0, 0]);
    // **Dropped from a height, not placed on the surface.** A body whose centre is exactly on the
    // surface is half inside the ground, so the first frame's collision blocks every move and the
    // walk never starts — which is the world being correct and the test being wrong.
    const player = createPlayer(onPlanet([1, 0, 0], 20), {}, FRAME);
    const upAtStart = player.up;
    for (let i = 0; i < 90; i++) {
      updatePlayer(player, 1 / 60, neutralInput(), world);
    }
    expect(player.onGround, "settled before the walk").toBe(true);

    const frames = 1800;
    let groundedFrames = 0;
    // **How far the player ever got above the ground, which is the measurement that matters.**
    // A frame that had not followed the surface would drift off it by `s²/2R` — four hundred
    // units by the end of this walk — so the bound here separates "following" from "not following"
    // by two orders of magnitude rather than by a yes or a no.
    let highestAbove = 0;
    const built = planet();
    const aboveSurface = (): number => {
      const r = length(player.position);
      const n = scale(player.position, 1 / r);
      return r - player.config.halfSize - built.radiusAt(n);
    };

    for (let i = 0; i < frames; i++) {
      updatePlayer(player, 1 / 60, { ...neutralInput(), moveY: 1 }, world);
      if (player.onGround) groundedFrames++;
      highestAbove = Math.max(highestAbove, aboveSurface());
    }

    const walked = length({
      x: player.position.x - start.x,
      y: player.position.y - start.y,
      z: player.position.z - start.z,
    });
    const turned = length({
      x: player.up.x - upAtStart.x,
      y: player.up.y - upAtStart.y,
      z: player.up.z - upAtStart.z,
    });
    const radius = length(player.position);
    console.log(
      `[planet] walked ${walked.toFixed(0)} units of a ${radius.toFixed(0)}-radius surface: ` +
        `up turned ${turned.toFixed(4)} against an arc of ` +
        `${(walked / radius).toFixed(4)} rad, grounded ${groundedFrames}/${frames} frames, ` +
        `never more than ${highestAbove.toFixed(2)} above the ground`,
    );

    // **Never more than a step above the ground.** A voxel is ten units and a step is ten, so a
    // player who is within a step of the surface is a player who is walking it rather than
    // bouncing along it.
    expect(highestAbove).toBeLessThan(player.config.stepHeight);
    expect(highestAbove).toBeGreaterThan(-player.config.stepHeight);
    // They walked — nearly thirty seconds at the configured speed, less the ramp-up.
    expect(walked).toBeGreaterThan(1500);
    // **The up followed the surface.** A frame that had not followed would show a turned of about
    // zero; one that followed twice over would show twice the arc.
    expect(turned).toBeGreaterThan(0.6 * (walked / radius));
    expect(turned).toBeLessThan(1.4 * (walked / radius));
    // **And they are on it — standing on it, or swimming over it.** Half this planet is ocean
    // (see "puts about half the planet under the sea"), and a thirty-second walk ends in the sea
    // about as often as not, so this cannot be one assertion. A body in water is held off the sea
    // floor by the swim drag rather than standing on it, which is the physics being correct.
    //
    // What has to hold either way is the thing that would be a real bug: the player is neither
    // inside the ground nor fallen through the world, and on land they are on it to a unit.
    const surface = planet().radiusAt(scale(player.position, 1 / radius));
    const feet = radius - player.config.halfSize;
    if (feet > SEA_RADIUS) {
      expect(player.onGround, "walked out on land, so standing on it").toBe(
        true,
      );
      expect(feet).toBeCloseTo(surface, 0);
    } else {
      expect(world.getInWaterAt(player.position), "walked into the sea").toBe(
        true,
      );
      // Above the sea floor, never through it — the assertion that actually matters here.
      expect(feet).toBeGreaterThan(surface);
    }
  });

  it("keeps the player on the ground over a walk that stays on land", () => {
    // **The strong version of the assertion above, over ground where it can hold.** Half the
    // planet being ocean is a good change; it should not cost the property that a player walking
    // on a hillside is on the hillside. A few hundred units from a start chosen for standing high
    // is long enough to cross a slope and short enough not to reach the coast.
    const world = planetWorld();
    const built = planet();
    // **Starting at the highest point on the planet, not merely above the water line.** A
    // ten-second walk is six hundred units of arc and the slopes here run at about a half, so
    // starting forty units above the sea means walking into it before the walk is over — a
    // perfectly good fact about the planet, and not what this test is for. From the summit there
    // is more downhill in any direction than the walk covers.
    const summit = highestPoint(built);
    expect(summit.radius, "this planet has land").toBeGreaterThan(SEA_RADIUS);
    const start = scale(summit.direction, summit.radius + 30);
    const player = createPlayer(start, {}, FRAME);
    for (let i = 0; i < 60; i++)
      updatePlayer(player, 1 / 60, neutralInput(), world);
    expect(player.onGround, "settled before the walk").toBe(true);

    let highestAbove = 0;
    for (let i = 0; i < 600; i++) {
      updatePlayer(player, 1 / 60, { ...neutralInput(), moveY: 1 }, world);
      const r = length(player.position);
      const n = scale(player.position, 1 / r);
      highestAbove = Math.max(
        highestAbove,
        r - player.config.halfSize - built.radiusAt(n),
      );
    }
    // **Then let them stop.** The claim is about where they come to rest, and the last frame of a
    // walk down a slope catches them in the air over the next drop — four units up and airborne is
    // a player walking downhill, not a player floating. The long walk above ends grounded by luck
    // of where the walk finished; this one ends deliberately.
    for (let i = 0; i < 120; i++)
      updatePlayer(player, 1 / 60, neutralInput(), world);

    const radius = length(player.position);
    const surface = built.radiusAt(scale(player.position, 1 / radius));
    console.log(
      `[planet] a ten-second land walk ended ${(radius - player.config.halfSize - surface).toFixed(2)} above the ground,`,
    );
    // **Never more than a step and a half up, and standing on it at the end.** The bound is looser
    // than the long walk's one step, and deliberately: the range term being signed and tripled took
    // the slopes from about a fifth to about a half, so a downhill step leaves the ground falling
    // away faster than gravity pulls and the player is briefly airborne over the drop. That is a
    // slope, not a bounce — the test that matters is that they are *never* much above the ground
    // and are on it when they stop.
    expect(highestAbove).toBeLessThan(1.5 * player.config.stepHeight);
    expect(radius).toBeGreaterThan(SEA_RADIUS);
    expect(player.onGround).toBe(true);
    // **Within a step of the surface, rather than on it.** On a landscape with real relief the
    // collision snaps a body up a ledge rather than into it, so a player standing on a step has
    // their feet up to `stepHeight` above the surface underneath them — which is correct, and is
    // why the long walk above can assert a tighter bound only because the ground it crossed was
    // smooth enough to walk without climbing.
    expect(Math.abs(radius - player.config.halfSize - surface)).toBeLessThan(
      player.config.stepHeight,
    );
  });
});

describe("the two worlds side by side", () => {
  it("a flat world and a planet differ only in what they are asked for", () => {
    // **The shape of the change, asserted.** Both worlds satisfy the same `PlayerWorld`
    // interface, built by the same `GameWorld`, from the same `BaseFieldSpec` union. Nothing in
    // the physics, the mesher or the streaming layer knows which it has — which is the property
    // that made this a two-file change rather than a rewrite.
    const flat = new GameWorld({
      field: () => {
        const base = baseFieldFor({
          kind: "terrain",
          params: { origin: -70, scale: 96, octaves: 4, seed: DEFAULT_SEED },
        });
        return new Field(new OperationBVH([]), {
          base,
          extent: base,
          lipschitz: base?.lipschitz,
        });
      },
      frame: flatFrame,
      seaRadius: -70,
    });
    const round = planetWorld();
    const worlds: PlayerWorld[] = [flat, round];

    for (const world of worlds) {
      expect(world.frame).toBeDefined();
      expect(world.centre).toBe(world.frame.centre);
      // The ground query works on both, and answers a distance.
      expect(
        typeof world.getGroundDistanceAt(vec3(0, 0, 0), vec3(0, 1, 0)),
      ).toBe("number");
    }
    // And the only structural difference is the centre, which is what the world bound reads.
    expect(flat.centre).toBeUndefined();
    expect(round.centre).toEqual(vec3(0, 0, 0));
    // A flat frame has an infinite radius, which is why the sea on a flat world is an altitude.
    expect(flat.frame.radiusAt(vec3(1e6, 0, 0))).toBe(Infinity);
    expect(round.frame.radiusAt(scale(vec3(1, 0, 0), 4000))).toBeCloseTo(
      4000,
      9,
    );
  });
});
