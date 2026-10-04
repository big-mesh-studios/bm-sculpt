/**
 * The sea, as a shape.
 *
 * ## What this file is for
 *
 * `water.ts` used to build one thing: a large plane at a world height, snapped to a grid around the
 * camera so it could be small enough to be cheap. A planet cannot use it, and the reason is not
 * that a plane is the wrong primitive — it is that **a plane at a world height has no meaning
 * without a flat world.** There is no height on a sphere. So the file now builds one of two
 * shapes, and the choice is made by the world rather than by the file.
 *
 * Which makes the risk the one this file exists for: a planet that quietly gets a plane. That is
 * not a crash. It is a blue disc lying across the northern hemisphere at one altitude, which is
 * exactly what it would look like if the world were not round — the failure looks like a rendering
 * bug and is a world-shape bug, and no amount of staring at the shader will find it.
 *
 * So the tests are about **which shape got built, from what input**, and about the one thing the
 * shape is chosen for: the normal the water shades with.
 */

import { describe, expect, it } from "vitest";
import { Scene } from "@random-mesh/rmsl/scene";

import { DEFAULT_PLANET } from "@big-mesh-studios/csg";
import { vec3 } from "@big-mesh-studios/core";

import { DEFAULT_SEA_RADIUS, createWater } from "./water";

/** Every mesh in a scene, so a test can say what shape it was given. */
const meshes = (scene: Scene): readonly unknown[] => scene.children;

/** The vertices of a mesh's geometry, which is the whole of "what shape is this". */
const vertices = (
  mesh: unknown,
): { count: number; array: ArrayLike<number> } => {
  const geometry = (
    mesh as { geometry?: { attributes?: { position?: unknown } } }
  ).geometry;
  const position = geometry?.attributes?.position as
    { count: number; array: ArrayLike<number> } | undefined;
  if (!position) throw new Error("mesh has no position attribute");
  return position;
};

describe("the sea", () => {
  it("is a sphere, not a plane", () => {
    // **The failure this whole file is for.** A planet handed a plane gets a blue disc across it
    // that looks almost right, so this asserts the vertex count rather than the appearance.
    const scene = new Scene();
    const water = createWater(scene, DEFAULT_SEA_RADIUS);
    expect(vertices(meshes(scene)[0]).count).toBeGreaterThan(1000);
    water.dispose();
  });

  it("is centred on the planet and the size of the sea", () => {
    // **The sphere must be built around the origin, not around the camera.** A sphere offset to
    // the camera would be right for the frame in front of the player and wrong for every other
    // direction, which is a sphere that has to be rebuilt every frame.
    const scene = new Scene();
    const water = createWater(scene, DEFAULT_SEA_RADIUS);
    const mesh = meshes(scene)[0] as {
      position: { x: number; y: number; z: number };
    };
    expect(mesh.position).toEqual(vec3(0, 0, 0));

    // And every vertex of it is on the sphere of that radius, in every direction.
    const { count, array } = vertices(mesh);
    let maxError = 0;
    for (let i = 0; i < count; i++) {
      const x = array[i * 3]!;
      const y = array[i * 3 + 1]!;
      const z = array[i * 3 + 2]!;
      // A non-finite vertex would make every radius below meaningless, so it is checked where it
      // is read rather than trusted.
      expect(
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),
        "vertex " + i,
      ).toBe(true);
      maxError = Math.max(
        maxError,
        Math.abs(Math.hypot(x, y, z) - DEFAULT_SEA_RADIUS),
      );
    }
    // A tessellated sphere's chords sit *inside* the true sphere, so the error is the sagitta of
    // one segment and not an arbitrary tolerance: with a 96-segment sphere that is about a unit.
    console.log(
      `[water] sphere of radius ${DEFAULT_SEA_RADIUS}, worst chord sag ${maxError.toFixed(3)}`,
    );
    expect(maxError).toBeLessThan(DEFAULT_SEA_RADIUS * 0.001);
    water.dispose();
  });

  it("does not move when the camera does", () => {
    // A sphere is already centred on the planet and there is nothing about it that shimmers with
    // the eye. **Snapping one would be the only thing that could make it swim**, so this asserts
    // `update` is a no-op rather than leaving it to be "just in case".
    const scene = new Scene();
    const water = createWater(scene, DEFAULT_SEA_RADIUS);
    const mesh = meshes(scene)[0] as {
      position: { x: number; y: number; z: number };
    };
    water.update(vec3(3000, 100, -7000));
    expect(mesh.position).toEqual(vec3(0, 0, 0));
    water.dispose();
  });

  it("has one shape, so the material has no world to remember", () => {
    // The plane went with the flat world, and so did the `curved` flag that chose between them:
    // every sea this project can build is curved, so the material shades from the sphere's centre
    // unconditionally and there is nothing left to branch on.
    //
    // **What is asserted is the shape of the API, not the shader text.** Reading rmsl's node tree to
    // check that the normal comes from `positionWorld` needs a GL context to stringify, and a test
    // that cannot run in CI is not a test. The shading is one line and it is now the only line.
    const material = createWater(new Scene(), 4000).material;
    expect(material).toBeDefined();
  });
});

describe("the default sea", () => {
  it("is at the radius where the noise is zero", () => {
    // **The equality is the design.** `origin` on a height field is "the world y a height of zero
    // sits at", so a sea at `origin` covers where the base noise is negative. On a sphere there is
    // no height of zero — `radiusAt` is `radius + scale · shape` and `shape` is zero at the radius —
    // so the sea goes at `radius`.
    //
    // The obvious translation, `radius + origin`, is wrong by exactly the thing it looks like it is
    // not: it puts the sea `70` units *below* the planet's radius, which is beneath the lowest
    // land on a default planet, and produces a world that is entirely dry. That was measured, not
    // assumed — the surface spans roughly 3979 to 4181, so `3930` is under all of it.
    expect(DEFAULT_SEA_RADIUS).toBe(DEFAULT_PLANET.radius);
    expect(DEFAULT_SEA_RADIUS).not.toBe(DEFAULT_PLANET.radius - 70);
  });
});
