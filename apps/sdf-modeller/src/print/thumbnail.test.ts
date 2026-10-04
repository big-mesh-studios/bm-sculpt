import { describe, expect, it } from "vitest";
import type { ChunkMesh } from "@big-mesh-studios/meshing";

import { boundsAbout } from "./fixtures";
import {
  cameraDistanceFor,
  thumbnailFromMesh,
  THUMBNAIL_SIZE,
} from "./thumbnail";

/** The vertical field of view the modeller draws at, in radians. */
const FOV = Math.PI / 4;

describe("cameraDistanceFor", () => {
  it("stands the camera outside the model", () => {
    // **A camera inside the bounding sphere sees the model from inside it**, which for a
    // thumbnail is a picture of the inside of a figure. The distance has to clear the radius by
    // more than the distance itself, and this is the property that says so.
    const bounds = boundsAbout(2);
    const radius = Math.hypot(1, 1, 1);

    expect(cameraDistanceFor(bounds, FOV)).toBeGreaterThan(radius);
  });

  it("frames by the model's diagonal rather than by its width", () => {
    // **A flat sheet is the case that tells the two apart.** Its width is two and its
    // half-diagonal is one and a bit, and the corners are what have to fit the frame — a
    // width-based fit would put the camera close enough to clip them.
    const sheet = {
      min: { x: -1, y: -1, z: -0.0005 },
      max: { x: 1, y: 1, z: 0.0005 },
    };
    const framed = cameraDistanceFor(sheet, FOV) * Math.sin(FOV / 2);

    expect(framed).toBeGreaterThan(1.2);
  });

  it("backs off for a narrower field of view", () => {
    // **The relationship is a division by a half-angle**, so a narrower field means a longer
    // throw for the same framing. A thumbnail taken from a camera that ignores this shows a
    // cropped model, which looks like a modelling mistake rather than a camera one.
    const bounds = boundsAbout(2);

    expect(cameraDistanceFor(bounds, FOV / 2)).toBeGreaterThan(
      cameraDistanceFor(bounds, FOV) * 1.5,
    );
  });

  it("backs off for a bigger model, by the same factor", () => {
    const small = cameraDistanceFor(boundsAbout(2), FOV);
    const large = cameraDistanceFor(boundsAbout(8), FOV);

    expect(large / small).toBeCloseTo(4, 6);
  });
});

describe("thumbnailFromMesh", () => {
  it("has nothing to photograph in a mesh with no vertices", async () => {
    // **The one path that returns before touching the GPU**, and therefore the one part of this
    // file a test can reach: an empty mesh has no geometry, so there is nothing to put in a
    // scene and no reason to make a target. `jsdom` has no WebGL and a test that mocks a
    // renderer's readback is a test of the mock.
    const empty: ChunkMesh = {
      positions: new Float32Array(0),
      normalOct: new Int16Array(0),
      colours: new Uint8Array(0),
      indices: new Uint32Array(0),
      vertexCount: 0,
      triangleCount: 0,
    };

    await expect(
      thumbnailFromMesh(undefined as never, empty, boundsAbout(2)),
    ).resolves.toBeUndefined();
  });
});

describe("THUMBNAIL_SIZE", () => {
  it("is a size a file manager and a slicer both draw at", () => {
    // **Not a rounding of a bigger one.** It is shown as an icon in a file list, so a larger
    // picture is bytes nobody sees.
    expect(THUMBNAIL_SIZE).toBeGreaterThanOrEqual(128);
    expect(THUMBNAIL_SIZE).toBeLessThanOrEqual(256);
  });
});
