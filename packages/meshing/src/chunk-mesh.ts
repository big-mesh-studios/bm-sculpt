/**
 * A chunk's mesh, in the layout the renderer uploads.
 *
 * Twenty bytes a vertex, three attributes:
 *
 *   position   float32x3    12 B  where the vertex is
 *   normalOct  snorm16x2     4 B  its normal, folded onto the octahedron
 *   colour     unorm8x4      4 B  its colour, plus a lane kept for a face index
 *
 * This is the layout ADR 0003 settled on and Phase 0 proved reaches the GPU, so the
 * mesher writes into something already known to work rather than something that has
 * to be changed later. `snorm16x2` rather than `unorm8x4` for the normal because
 * both are four bytes and the signed pair arrives already spanning -1 to 1, which is
 * the range the octahedral encoding lives in.
 *
 * Colours are per vertex rather than sampled from a palette texture. A voxel mesher
 * carries a palette index because its faces are axis-aligned and a face index names
 * the normal in one byte; a surface nets mesh has neither, so it already pays for a
 * colour channel and would only be saving by adding a texture fetch.
 */

import type { Rgb8 } from "@big-mesh-studios/core";
import { Growable } from "./growable";
import type { SurfaceOutput } from "./surface-nets";
import { SNORM16_MAX, writeOctahedralNormal } from "@big-mesh-studios/core";

/** Bytes one vertex occupies across the three attributes. */
export const VERTEX_BYTES = 12 + 4 + 4;

/** How many samples a full chunk owns per axis, and so how big its buffers get. */
export const CHUNK_VERTEX_CAPACITY = 4096;

export interface ChunkMesh {
  /** World positions, three per vertex. */
  positions: Float32Array;
  /** Two signed 16-bit channels a vertex, holding its octahedral normal. */
  normalOct: Int16Array;
  /** Four bytes a vertex: the colour, and a lane left free. */
  colours: Uint8Array;
  /** Three indices a triangle. */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/** Accumulates a chunk's geometry, and satisfies `SurfaceOutput` directly. */
export class ChunkMeshBuilder implements SurfaceOutput {
  readonly positions = new Growable<Float32Array>(Float32Array, 4096);
  readonly normalOct = new Growable<Int16Array>(Int16Array, 4096);
  readonly colours = new Growable<Uint8Array>(Uint8Array, 8192);
  readonly indices = new Growable<Uint32Array>(Uint32Array, 4096);

  clear(): void {
    this.positions.clear();
    this.normalOct.clear();
    this.colours.clear();
    this.indices.clear();
  }

  get vertexCount(): number {
    return this.positions.size / 3;
  }

  get triangleCount(): number {
    return this.indices.size / 3;
  }

  vertex(x: number, y: number, z: number): number {
    const index = this.vertexCount;
    this.positions.push(x);
    this.positions.push(y);
    this.positions.push(z);
    // The normal is filled in by `setNormal` from the field gradient, which the mesher
    // computes once per vertex. A placeholder of +Y would be a real direction rather
    // than an obvious sentinel, so a vertex whose normal is never set would shade as
    // if it were right.
    this.normalOct.push(0);
    this.normalOct.push(0);
    // A colour of white and an opaque alpha, for the same reason.
    this.colours.push(255);
    this.colours.push(255);
    this.colours.push(255);
    this.colours.push(255);
    return index;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a);
    this.indices.push(b);
    this.indices.push(c);
    this.indices.push(a);
    this.indices.push(c);
    this.indices.push(d);
  }

  /**
   * Appends one triangle.
   *
   * **Not `quad` with a repeated vertex**, which is the tempting one-liner and produces two
   * indices referring to the same position — a zero-area face that a normal calculation has to
   * special-case and a slicer either rejects or prints as a speck.
   */
  triangle(a: number, b: number, c: number): void {
    this.indices.push(a);
    this.indices.push(b);
    this.indices.push(c);
  }

  /** Writes a vertex's normal, folding it onto the octahedron. */
  setNormal(index: number, x: number, y: number, z: number): void {
    writeOctahedralNormal(this.normalOct.array(), index * 2, { x, y, z });
  }

  /** Writes a vertex's colour. */
  /**
   * Sets one vertex's colour, and optionally how opaque it is.
   *
   * **Alpha is a separate argument with a default of 255 rather than part of
   * `Rgb8`, and that is deliberate.** The packed vertex is four bytes and the third
   * of them has always been the alpha, but `Rgb8` is what `Operation.colour` is and
   * what every caller has in hand. Widening the colour type to carry alpha would
   * have made every colour in the repository four-wide to serve one of them, so the
   * default keeps the two-argument call meaning exactly what it meant before.
   */
  setColour(index: number, colour: Rgb8, alpha = 255): void {
    this.colours.setAt(index * 4, colour.r);
    this.colours.setAt(index * 4 + 1, colour.g);
    this.colours.setAt(index * 4 + 2, colour.b);
    this.colours.setAt(index * 4 + 3, alpha);
  }

  /** Reads a vertex's position. */
  positionOf(index: number): { x: number; y: number; z: number } {
    const at = index * 3;
    return {
      x: this.positions.at(at),
      y: this.positions.at(at + 1),
      z: this.positions.at(at + 2),
    };
  }

  /**
   * The finished mesh, with each array **copied** to its exact length.
   *
   * A copy, not a view, and the distinction is not a detail: what leaves a meshing
   * worker crosses a thread boundary by transfer, which detaches a view and would
   * deliver an empty array to the main thread.
   */
  finish(): ChunkMesh {
    return {
      positions: this.positions.exact(),
      normalOct: this.normalOct.exact(),
      colours: this.colours.exact(),
      indices: this.indices.exact(),
      vertexCount: this.vertexCount,
      triangleCount: this.triangleCount,
    };
  }
}

/** How many bytes a mesh of this many vertices occupies. */
export const meshBytes = (vertexCount: number): number =>
  vertexCount * VERTEX_BYTES;

/** The largest value a `snorm16x2` channel carries, for tests and decode. */
export { SNORM16_MAX };
