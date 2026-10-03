/**
 * The vertex layout the rest of the project will use, built once and on show.
 *
 * Three attributes, twelve bytes plus four plus four:
 *
 *   position   float32x3    12 B  where the vertex is
 *   normalOct  snorm16x2     4 B  its normal, folded onto the octahedron
 *   colour     unorm8x4      4 B  its colour, plus two lanes left spare
 *
 * This is the format the plan calls for, so proving it here means the mesher in
 * Phase 3 writes into a layout already known to reach the GPU. Both compact
 * formats are `unnormalized`-style fixed point at four bytes, which is what lets
 * them sit in the same record as a `float32x3` — RMSL gives every format its own
 * buffer, and a buffer's stride has to be a multiple of four, so a narrower
 * format would have to be widened to be usable at all.
 *
 * The normal is `snorm16x2` rather than `unorm8x4` deliberately. Both are four
 * bytes; `snorm16x2` spends them on sixteen bits per component and arrives at
 * the shader already spanning -1 to 1, which is the range the octahedral
 * encoding lives in. Eight bits per component would leave visible banding on a
 * smooth surface — roughly four tenths of a degree of error — for no saving.
 */

import { BufferAttribute, BufferGeometry } from "@random-mesh/rmsl/scene";
import type { Vec3 } from "@big-mesh-studios/core";
import { normalized, writeOctahedralNormal } from "@big-mesh-studios/core";

/** What one mesh's vertex data amounts to, before it reaches a geometry. */
export interface VertexData {
  positions: Float32Array;
  /** Two signed 16-bit channels a vertex, holding its octahedral normal. */
  normalOct: Int16Array;
  /** Four bytes a vertex: the colour, and two lanes left for whatever comes next. */
  colours: Uint8Array;
  indices: Uint32Array;
  /** How many vertices the arrays above describe. */
  vertexCount: number;
}

/**
 * Bytes one vertex occupies across the three attributes, which is what a
 * generated upload budget is denominated in. Kept next to the layout rather than
 * in a constant elsewhere so the two cannot drift; `spike-geometry.test.ts`
 * checks it against what RMSL actually infers.
 */
export const VERTEX_BYTES = 12 + 4 + 4;

/** A colour as the `unorm8x4` lane group carries it: bytes, 0 to 255. */
export interface Rgb8 {
  r: number;
  g: number;
  b: number;
}

/**
 * Accumulates vertices in the three attribute arrays. One per mesh, so the
 * arrays are sized once from a triangle count rather than grown per vertex.
 */
export class VertexWriter {
  readonly positions: Float32Array;
  readonly normalOct: Int16Array;
  readonly colours: Uint8Array;
  private readonly indices: Uint32Array;
  private verticesWritten = 0;
  private indicesWritten = 0;

  constructor(
    readonly capacity: number,
    readonly indexCapacity: number,
  ) {
    this.positions = new Float32Array(capacity * 3);
    this.normalOct = new Int16Array(capacity * 2);
    this.colours = new Uint8Array(capacity * 4);
    this.indices = new Uint32Array(indexCapacity);
  }

  /** How many vertices have been written, which is also the next one's index. */
  get vertexCount(): number {
    return this.verticesWritten;
  }

  /** Adds a vertex, returning its index for the triangles to refer back to. */
  vertex(position: Vec3, normal: Vec3, colour: Rgb8): number {
    if (this.verticesWritten >= this.capacity) {
      // A typed array drops writes past its end without complaint, so an
      // undersized buffer does not fail — it produces a mesh with a truncated
      // index list and missing geometry, and nothing anywhere reports it. The
      // mesher in a later phase is sized by a triangle count it computes itself,
      // and this is the same class of mistake.
      throw new Error(
        `vertex capacity ${this.capacity} exhausted after ${this.verticesWritten} vertices`,
      );
    }
    const at = this.verticesWritten++;
    this.positions[at * 3] = position.x;
    this.positions[at * 3 + 1] = position.y;
    this.positions[at * 3 + 2] = position.z;
    writeOctahedralNormal(this.normalOct, at * 2, normal);
    this.colours[at * 4] = colour.r;
    this.colours[at * 4 + 1] = colour.g;
    this.colours[at * 4 + 2] = colour.b;
    // The fourth lane stays opaque. It is where a face index or a light level
    // would go once there is one to carry, and writing it now rather than leaving
    // it undefined means the attribute is a full four channels from the start and
    // nothing has to change when it starts being read.
    this.colours[at * 4 + 3] = 255;
    return at;
  }

  /** Adds a triangle, winding the three vertices in the order given. */
  triangle(a: number, b: number, c: number): void {
    if (this.indicesWritten + 3 > this.indexCapacity) {
      throw new Error(
        `index capacity ${this.indexCapacity} exhausted after ${this.indicesWritten} indices`,
      );
    }
    const at = this.indicesWritten;
    this.indices[at] = a;
    this.indices[at + 1] = b;
    this.indices[at + 2] = c;
    this.indicesWritten = at + 3;
  }

  /** Adds a quad as two triangles from four corners in order round the face. */
  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  /** The arrays as they now stand, trimmed to what was written. */
  finish(): VertexData {
    return {
      positions: this.positions.slice(0, this.verticesWritten * 3),
      normalOct: this.normalOct.slice(0, this.verticesWritten * 2),
      colours: this.colours.slice(0, this.verticesWritten * 4),
      indices: this.indices.slice(0, this.indicesWritten),
      vertexCount: this.verticesWritten,
    };
  }
}

/** Builds a geometry carrying the three attributes above. */
export const toGeometry = (data: VertexData): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(data.positions, 3, false, "vertex"),
  );
  // `normalized` is what turns these bytes into signed fractions on the way in;
  // without it a `Int16Array` reads as whole numbers and every normal in the
  // scene points a thousand degrees off.
  geometry.setAttribute(
    "normalOct",
    new BufferAttribute(data.normalOct, 2, true, "vertex"),
  );
  geometry.setAttribute(
    "colour",
    new BufferAttribute(data.colours, 4, true, "vertex"),
  );
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  return geometry;
};

/**
 * A UV sphere whose vertex normals are the directions from its centre, so the
 * surface shades as smoothly as its segments allow. The point of it in this
 * build is the normal encoding: if the octahedral fold is wrong, a smoothly
 * shaded sphere is the thing that shows it, because a wrong fold turns a
 * continuous normal field into something faceted and lumpy.
 *
 * Topologically closed, not merely closed-looking. The last column of vertices
 * wraps back onto the first rather than duplicating it, and the two poles are
 * triangle fans rather than rings of degenerate quads — both so that every edge
 * is shared by exactly two triangles. A sphere that only looks closed has
 * boundary edges along its seam and around its poles, which is invisible from
 * outside and obvious the moment a camera goes inside it.
 */
export const buildSphere = (
  radius: number,
  widthSegments: number,
  heightSegments: number,
  colour: Rgb8,
): VertexData => {
  const w = widthSegments;
  const h = heightSegments;
  // A pole is one vertex, not a ring of coincident ones: a fan whose apex is one
  // of several vertices at the same point leaves the rest referenced by nothing,
  // and a surface with unreferenced vertices has boundary edges even though it
  // looks closed.
  const interiorRings = h - 1;
  const interiorCount = interiorRings * w;
  // A fan of w triangles at each pole, and a quad — two triangles — for each of
  // the interior rings that has another ring to join to. Counted rather than
  // estimated: an estimate that falls short costs geometry silently.
  const poleTriangles = 2 * w;
  const bandTriangles = Math.max(0, interiorRings - 1) * w * 2;
  const writer = new VertexWriter(
    interiorCount + 2,
    (poleTriangles + bandTriangles) * 3,
  );

  const directionAt = (phi: number, theta: number): Vec3 => {
    const sinPhi = Math.sin(phi);
    return normalized({
      x: sinPhi * Math.cos(theta),
      y: Math.cos(phi),
      z: sinPhi * Math.sin(theta),
    });
  };
  const addPole = (phi: number): number => {
    const n = directionAt(phi, 0);
    return writer.vertex(
      { x: n.x * radius, y: n.y * radius, z: n.z * radius },
      n,
      colour,
    );
  };

  const north = addPole(0);
  // Ring `ring` of the interior, counting from 1, wrapping so the last column
  // joins the first rather than duplicating it.
  const ring = (which: number, column: number): number =>
    1 + (which - 1) * w + (column % w);
  const thetaAt = (column: number): number => ((column % w) / w) * Math.PI * 2;

  for (let which = 1; which <= interiorRings; which++) {
    const phi = (which / h) * Math.PI;
    for (let column = 0; column < w; column++) {
      const n = directionAt(phi, thetaAt(column));
      writer.vertex(
        { x: n.x * radius, y: n.y * radius, z: n.z * radius },
        n,
        colour,
      );
    }
  }

  const south = addPole(Math.PI);

  for (let column = 0; column < w; column++) {
    writer.triangle(north, ring(1, column), ring(1, column + 1));
    writer.triangle(
      south,
      ring(interiorRings, column + 1),
      ring(interiorRings, column),
    );
  }
  for (let which = 1; which < interiorRings; which++) {
    for (let column = 0; column < w; column++) {
      writer.quad(
        ring(which, column),
        ring(which + 1, column),
        ring(which + 1, column + 1),
        ring(which, column + 1),
      );
    }
  }

  return writer.finish();
};

/**
 * A box whose six faces each carry one normal and one colour. The counterpart
 * to the sphere: because every corner of a face agrees, the face shades as a
 * flat plane, which is what tells a working decode apart from one that merely
 * round-trips.
 */
export const buildBox = (
  half: Vec3,
  faceColours: readonly Rgb8[],
): VertexData => {
  const writer = new VertexWriter(24, 36);

  // Each face is named by the axis it faces along and the sign of that axis,
  // with the two tangent axes it spans. The corner order is counter-clockwise
  // seen from outside, so the quad winding that follows is outward too.
  const faces: ReadonlyArray<{
    normal: Vec3;
    u: Vec3;
    v: Vec3;
  }> = [
    {
      normal: { x: 0, y: 0, z: 1 },
      u: { x: -1, y: 0, z: 0 },
      v: { x: 0, y: 1, z: 0 },
    },
    {
      normal: { x: 0, y: 0, z: -1 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 1, z: 0 },
    },
    {
      normal: { x: 1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: -1 },
      v: { x: 0, y: 1, z: 0 },
    },
    {
      normal: { x: -1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: 1 },
      v: { x: 0, y: 1, z: 0 },
    },
    {
      normal: { x: 0, y: 1, z: 0 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 0, z: -1 },
    },
    {
      normal: { x: 0, y: -1, z: 0 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 0, z: 1 },
    },
  ];

  faces.forEach((face, at) => {
    const colour = faceColours[at] ?? { r: 255, g: 255, b: 255 };
    // How far the box reaches along each of the two axes the face spans. Taking
    // it as a dot of the axis with the half-extents rather than reading one
    // component is what keeps a face spanning X and Z correctly sized when the
    // box is not a cube — reading a component assumes an axis the code named
    // rather than one it derived.
    const uScale = face.u.x * half.x + face.u.y * half.y + face.u.z * half.z;
    const vScale = face.v.x * half.x + face.v.y * half.y + face.v.z * half.z;
    const corner = (a: number, b: number): Vec3 => ({
      x: face.normal.x * half.x + face.u.x * uScale * a + face.v.x * vScale * b,
      y: face.normal.y * half.y + face.u.y * uScale * a + face.v.y * vScale * b,
      z: face.normal.z * half.z + face.u.z * uScale * a + face.v.z * vScale * b,
    });
    const base = writer.vertexCount;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      writer.vertex(corner(a, b), face.normal, colour);
    }
    writer.quad(base, base + 1, base + 2, base + 3);
  });

  return writer.finish();
};
