import { describe, expect, it } from "vitest";

import {
  BufferAttribute,
  VERTEX_FORMATS,
  vertexFormatOf,
  type VertexFormat,
} from "@random-mesh/rmsl/scene";

import {
  buildBox,
  buildSphere,
  toGeometry,
  VERTEX_BYTES,
} from "./spike-geometry";

describe("the vertex layout RMSL infers", () => {
  it("reads a signed 16-bit pair of components as snorm16x2", () => {
    // This is the load-bearing assertion of the whole layout. RMSL decides an
    // attribute's format from its array type, its component count and its
    // `normalized` flag, and a wrong reading is silent: a `snorm16x2` read as
    // whole numbers puts every normal in the scene a thousand degrees off, and
    // the shader still compiles, the draw still happens, and the result is a
    // black or white screen rather than an error.
    const attribute = new BufferAttribute(new Int16Array(8), 2, true, "vertex");
    expect(vertexFormatOf(attribute)).toBe("snorm16x2");
    expect(VERTEX_FORMATS.snorm16x2.count).toBe(2);
    expect(VERTEX_FORMATS.snorm16x2.bytes).toBe(2);
  });

  it("reads an unsigned 8-bit quad of components as unorm8x4", () => {
    const attribute = new BufferAttribute(
      new Uint8Array(16),
      4,
      true,
      "vertex",
    );
    expect(vertexFormatOf(attribute)).toBe("unorm8x4");
    expect(VERTEX_FORMATS.unorm8x4.count).toBe(4);
    expect(VERTEX_FORMATS.unorm8x4.bytes).toBe(1);
  });

  it("reads an unnormalized float triple as float32x3", () => {
    const attribute = new BufferAttribute(
      new Float32Array(12),
      3,
      false,
      "vertex",
    );
    expect(vertexFormatOf(attribute)).toBe("float32x3");
  });

  it("distinguishes signed from unsigned and normalized from whole numbers", () => {
    // The three flags are the only things telling these apart, so a regression
    // that dropped one of them would silently merge formats. Each pair below
    // differs by exactly one.
    const cases: Array<[string, VertexFormat]> = [
      [
        "snorm16x2",
        vertexFormatOf(new BufferAttribute(new Int16Array(4), 2, true)),
      ],
      [
        "unorm16x2",
        vertexFormatOf(new BufferAttribute(new Uint16Array(4), 2, true)),
      ],
      [
        "snorm16x4",
        vertexFormatOf(new BufferAttribute(new Int16Array(8), 4, true)),
      ],
      [
        "unorm16x4",
        vertexFormatOf(new BufferAttribute(new Uint16Array(8), 4, true)),
      ],
      [
        "snorm8x4",
        vertexFormatOf(new BufferAttribute(new Int8Array(8), 4, true)),
      ],
      [
        "unorm8x4",
        vertexFormatOf(new BufferAttribute(new Uint8Array(8), 4, true)),
      ],
    ];
    expect(new Set(cases.map(([name]) => name)).size).toBe(cases.length);
  });

  it("honours an attribute that declares its own format", () => {
    // The case the array type cannot settle: a `Uint16Array` reads identically
    // whether it holds half floats or normalized integers, and only the author
    // knows which. RMSL refuses to guess — left undeclared it throws, with a
    // message naming both ways out — rather than reading the bytes as something
    // they are not.
    const undeclared = new BufferAttribute(new Uint16Array(4), 2, false);
    expect(() => vertexFormatOf(undeclared)).toThrow(/no vertex format/);

    const halves = new BufferAttribute(new Uint16Array(4), 2, false);
    halves.format = "float16x2";
    expect(vertexFormatOf(halves)).toBe("float16x2");

    const normalized = new BufferAttribute(new Uint16Array(4), 2, true);
    expect(vertexFormatOf(normalized)).toBe("unorm16x2");
  });

  it("gives every format in the table a stride that is a multiple of four", () => {
    // The rule that shapes the format list at all: WebGPU requires a vertex
    // buffer's stride to be a multiple of four, and RMSL gives each format its
    // own buffer. A format that fails this cannot be used without widening it.
    for (const [name, spec] of Object.entries(VERTEX_FORMATS)) {
      expect(`${name}:${spec.count * spec.bytes}`).toMatch(/:\d+$/);
      expect((spec.count * spec.bytes) % 4, `${name} stride`).toBe(0);
    }
  });
});

describe("the geometry the spikes draw", () => {
  it("matches VERTEX_BYTES to the bytes its own attributes imply", () => {
    const geometry = toGeometry(buildSphere(1, 8, 6, { r: 1, g: 1, b: 1 }));
    let stride = 0;
    for (const name of ["position", "normalOct", "colour"]) {
      const attribute = geometry.getAttribute(name);
      expect(attribute, name).toBeDefined();
      stride +=
        VERTEX_FORMATS[vertexFormatOf(attribute!)].count *
        VERTEX_FORMATS[vertexFormatOf(attribute!)].bytes;
    }
    // The number the upload budget will be denominated in has to be the number
    // the GPU is actually handed, or a budget derived from it is wrong by a
    // factor nobody would notice until a frame overran by exactly that much.
    expect(stride).toBe(VERTEX_BYTES);
    expect(VERTEX_BYTES).toBe(20);
  });

  it("closes the sphere, with every index inside the vertex range", () => {
    const sphere = buildSphere(10, 16, 12, { r: 255, g: 255, b: 255 });
    expect(sphere.indices.length % 3).toBe(0);
    for (const index of sphere.indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(sphere.vertexCount);
    }

    // Watertight means every edge is shared by exactly two triangles, and no
    // vertex is unreferenced. The count follows from that: a closed triangle
    // surface has half as many edges as edge incidences, so three edges per
    // triangle times the triangle count, halved. Asserting the total catches a
    // duplicated or dropped triangle; asserting each edge's own count catches a
    // seam that the total alone would let through.
    const triangles = sphere.indices.length / 3;
    expect(edgeUseCount(sphere.indices).every((uses) => uses === 2)).toBe(true);
    expect(distinctEdges(sphere.indices)).toBe((triangles * 3) / 2);

    // And Euler's characteristic for a sphere, which is the same statement
    // counted from the other end: vertices, minus edges, plus faces is two.
    expect(sphere.vertexCount - distinctEdges(sphere.indices) + triangles).toBe(
      2,
    );
  });

  it("references every vertex it declares", () => {
    // The failure mode above was a pole fan whose apex was one of several
    // coincident vertices, leaving the rest referenced by nothing. A vertex
    // nothing points at is a boundary, whatever it looks like from outside.
    for (const data of [
      buildSphere(10, 16, 12, WHITE),
      buildBox({ x: 1, y: 1, z: 1 }, SIX_WHITE),
    ]) {
      const used = new Set(data.indices);
      expect(used.size).toBe(data.vertexCount);
    }
  });

  it("puts every vertex of the sphere on its surface", () => {
    const radius = 7.5;
    const sphere = buildSphere(radius, 24, 16, WHITE);
    for (let at = 0; at < sphere.vertexCount; at++) {
      const distance = Math.hypot(
        sphere.positions[at * 3],
        sphere.positions[at * 3 + 1],
        sphere.positions[at * 3 + 2],
      );
      expect(distance).toBeCloseTo(radius, 5);
    }
  });

  it("gives the box six flat faces of four corners each", () => {
    const box = buildBox({ x: 1, y: 2, z: 3 }, [
      { r: 1, g: 1, b: 1 },
      { r: 1, g: 1, b: 1 },
      { r: 1, g: 1, b: 1 },
      { r: 1, g: 1, b: 1 },
      { r: 1, g: 1, b: 1 },
      { r: 1, g: 1, b: 1 },
    ]);
    expect(box.vertexCount).toBe(24);
    expect(box.indices.length).toBe(36);
  });

  it("sizes a box by the axis its face spans, not by a named component", () => {
    // A non-cube box is the case that catches the bug where a face's second
    // tangent axis is scaled by the wrong half-extent. Its twelve corners have
    // to land on the box's real extents whatever the proportions.
    const half = { x: 1, y: 5, z: 9 };
    const box = buildBox(
      half,
      Array.from({ length: 6 }, () => ({ r: 1, g: 1, b: 1 })),
    );
    for (let at = 0; at < box.vertexCount; at++) {
      expect(Math.abs(box.positions[at * 3])).toBeLessThanOrEqual(
        half.x + 1e-6,
      );
      expect(Math.abs(box.positions[at * 3 + 1])).toBeLessThanOrEqual(
        half.y + 1e-6,
      );
      expect(Math.abs(box.positions[at * 3 + 2])).toBeLessThanOrEqual(
        half.z + 1e-6,
      );
    }
    // And the far corners must actually reach them, or the test above passes on
    // a box that collapsed.
    const xs = Array.from(box.positions.filter((_, i) => i % 3 === 0));
    const ys = Array.from(box.positions.filter((_, i) => i % 3 === 1));
    const zs = Array.from(box.positions.filter((_, i) => i % 3 === 2));
    expect(Math.max(...xs)).toBeCloseTo(half.x, 6);
    expect(Math.max(...ys)).toBeCloseTo(half.y, 6);
    expect(Math.max(...zs)).toBeCloseTo(half.z, 6);
  });

  it("leaves the fourth colour lane whole", () => {
    // The lane a face index or a light level would eventually occupy. It is set
    // now rather than left undefined so the attribute is a full four channels
    // from the start and nothing has to change when it starts being read.
    const box = buildBox({ x: 1, y: 1, z: 1 }, []);
    for (let at = 0; at < box.vertexCount; at++) {
      expect(box.colours[at * 4 + 3]).toBe(255);
    }
  });
});

/** A key for an edge, the same whichever way round the triangle names it. */
const edgeKey = (a: number, b: number): string =>
  a < b ? `${a},${b}` : `${b},${a}`;

/** The three edges of every triangle in the list. */
const eachEdge = function* (indices: Uint32Array): Generator<string> {
  for (let at = 0; at < indices.length; at += 3) {
    yield edgeKey(indices[at], indices[at + 1]);
    yield edgeKey(indices[at + 1], indices[at + 2]);
    yield edgeKey(indices[at + 2], indices[at]);
  }
};

/** How many triangles share each distinct edge. */
const edgeUseCount = (indices: Uint32Array): number[] => {
  const counts = new Map<string, number>();
  for (const key of eachEdge(indices)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()];
};

/** How many distinct edges there are, however they are wound. */
const distinctEdges = (indices: Uint32Array): number =>
  new Set(eachEdge(indices)).size;

const WHITE = { r: 255, g: 255, b: 255 };
const SIX_WHITE = Array.from({ length: 6 }, () => ({ r: 1, g: 1, b: 1 }));
