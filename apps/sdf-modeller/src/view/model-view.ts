/**
 * Putting a model's mesh on the screen, and taking the old one off it first.
 *
 * ## Why this is twenty lines and not a shared package
 *
 * **Because it is twenty lines.** `packages/meshing` hands back a packed `ChunkMesh` —
 * twenty bytes a vertex — and turning that into rmsl's `BufferGeometry` is three attribute
 * calls and an index. The alternative is a package that exists to wrap three calls, whose
 * only content is an rmsl dependency that `packages/meshing` deliberately does not have
 * (ADR 0024: meshing returns vertex data, not node graphs).
 *
 * ## Why the outgoing geometry is disposed *before* the new one is built
 *
 * **So a slot is never holding two sets of buffers even momentarily**, and so a rebuild
 * that throws leaves the model with nothing rather than with something that does not
 * match its parts. The second half is the one that matters: a mesh on screen that does not
 * correspond to the model is a lie a person cannot see through, and it is exactly what a
 * half-finished rebuild would leave behind.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  type Scene,
} from "@random-mesh/rmsl/scene";
import type { ChunkMesh } from "@big-mesh-studios/meshing";

import type { MeshResult } from "../model/mesh-model";
import { modelMaterial } from "./model-material";

/**
 * rmsl geometry from a packed mesh.
 *
 * **`undefined` for a mesh with no vertices**, which is different from a mesh that failed:
 * the caller draws nothing rather than installing an empty geometry that will still cost
 * a draw call and still be wrong if the model changes.
 */
export const toGeometry = (mesh: ChunkMesh): BufferGeometry | undefined => {
  if (mesh.vertexCount === 0) return undefined;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(mesh.positions, 3, false, "vertex"),
  );
  geometry.setAttribute(
    "normalOct",
    new BufferAttribute(mesh.normalOct, 2, true, "vertex"),
  );
  geometry.setAttribute(
    "colour",
    new BufferAttribute(mesh.colours, 4, true, "vertex"),
  );
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
};

export interface ModelView {
  /** The mesh on screen, or undefined when the model has nothing to draw. */
  readonly mesh: () => Mesh | undefined;
  readonly triangles: () => number;
  /**
   * Swaps in a new mesh. Passing undefined removes what is there.
   *
   * `translucent` is passed rather than derived from the mesh because **a mesh cannot say
   * whether it wants blending** — every vertex carries an alpha either way, and the packed
   * format's fourth byte is opaque for a model with no transparency in it. So an always-
   * transparent material would put a fully opaque model into the transparent queue with
   * depth writes off, which is the arrangement that makes a solid self-overlap wrongly.
   */
  readonly install: (
    result: MeshResult | undefined,
    translucent: boolean,
  ) => void;
  readonly dispose: () => void;
}

export const createModelView = (scene: Scene): ModelView => {
  let geometry: BufferGeometry | undefined;
  let drawn: Mesh | undefined;
  let triangles = 0;

  const release = (): void => {
    // Guarded rather than passed through, because `scene.remove` takes a non-optional
    // `Object3D` and there is nothing to remove before the first install.
    if (drawn !== undefined) scene.remove(drawn);
    geometry?.dispose();
    geometry = undefined;
    drawn = undefined;
    triangles = 0;
  };

  return {
    mesh: () => drawn,

    triangles: () => triangles,

    install: (result, translucent) => {
      // **Disposed first, before the new geometry is even built.** See the header.
      release();
      if (result === undefined) return;
      const built = toGeometry(result.mesh);
      if (built === undefined) return;
      geometry = built;
      drawn = new Mesh(built, modelMaterial(translucent));
      scene.add(drawn);
      triangles = result.triangles;
    },

    dispose: release,
  };
};
