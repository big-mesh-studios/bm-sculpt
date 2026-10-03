/**
 * The mesh assertions both mesher tests need.
 *
 * **Shared because the two meshers are supposed to be interchangeable, and a helper that only one
 * of them is tested with cannot show that.** `surface-nets.test.ts` grew these to pin its own seam
 * rule; marching cubes has the same requirements for the same reasons, and copying them would leave
 * two definitions of "the same vertex" that could drift by a rounding place and pass separately.
 *
 * Everything here compares **by position, not by index**, and the header of `mesh-report.ts` is the
 * long version of why: a chunked mesh is watertight without sharing vertices, so an index-wise
 * count reports a correct mesh as broken.
 */

import type { ChunkMesh } from "./chunk-mesh";

/** Rounded so that position comparisons are about geometry, not float printing. */
export const at4 = (value: number): string => value.toFixed(4);

/** A vertex's position as a comparable key. */
export const positionKey = (
  mesh: { positions: Float32Array },
  index: number,
): string => {
  const at = index * 3;
  return `${at4(mesh.positions[at] as number)},${at4(mesh.positions[at + 1] as number)},${at4(mesh.positions[at + 2] as number)}`;
};

/** An unordered pair of vertex indices, so winding is not baked into the comparison. */
export const edgeKey = (a: number, b: number): string =>
  a < b ? `${a},${b}` : `${b},${a}`;

/** The same, for two already-formatted position keys. */
export const positionEdgeKey = (a: string, b: string): string =>
  a < b ? `${a}~${b}` : `${b}~${a}`;

/** How many triangles each distinct index edge belongs to. */
export const edgeUses = (indices: ArrayLike<number>): Map<string, number> => {
  const uses = new Map<string, number>();
  for (let at = 0; at + 2 < indices.length; at += 3) {
    for (const [p, q] of [
      [indices[at] as number, indices[at + 1] as number],
      [indices[at + 1] as number, indices[at + 2] as number],
      [indices[at + 2] as number, indices[at] as number],
    ] as const) {
      const key = edgeKey(p, q);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
};

/**
 * Triangles keyed by position, with the cyclic rotation that puts them in a canonical order but
 * **not** a reversal.
 *
 * Rotation rather than reversal is deliberate: it makes two meshes comparable only if they agree
 * about which way round each triangle goes, so a quad wound backwards at a chunk seam fails this
 * rather than passing quietly.
 */
export const canonicalTriangles = (mesh: ChunkMesh): string[] => {
  const triangles: string[] = [];
  for (let at = 0; at + 2 < mesh.indices.length; at += 3) {
    const v = [
      positionKey(mesh, mesh.indices[at] as number),
      positionKey(mesh, mesh.indices[at + 1] as number),
      positionKey(mesh, mesh.indices[at + 2] as number),
    ];
    let first = 0;
    for (let i = 1; i < 3; i++) if (v[i]! < v[first]!) first = i;
    triangles.push(
      [v[first], v[(first + 1) % 3], v[(first + 2) % 3]].join("|"),
    );
  }
  return triangles;
};

/** Eight origins covering `[0, 2 * span]` on every axis. */
export const tileOrigins = (
  span: number,
): ReadonlyArray<readonly [number, number, number]> => {
  const origins: Array<readonly [number, number, number]> = [];
  for (const z of [0, span]) {
    for (const y of [0, span]) {
      for (const x of [0, span]) origins.push([x, y, z]);
    }
  }
  return origins;
};

/** A sphere's signed distance, the simplest field with a surface to find. */
export const sphere =
  (cx: number, cy: number, cz: number, radius: number) =>
  (x: number, y: number, z: number): number =>
    Math.hypot(x - cx, y - cy, z - cz) - radius;

/** A torus's signed distance: the saddle case, where a surface is least well conditioned. */
export const torus =
  (cx: number, cy: number, cz: number, major: number, minor: number) =>
  (x: number, y: number, z: number): number =>
    Math.hypot(Math.hypot(x - cx, y - cy) - major, z - cz) - minor;

/** The volume of a torus, for the error assertion. */
export const torusVolume = (major: number, minor: number): number =>
  2 * Math.PI ** 2 * major * minor ** 2;

/** The volume of a sphere. */
export const sphereVolume = (radius: number): number =>
  (4 / 3) * Math.PI * radius ** 3;
