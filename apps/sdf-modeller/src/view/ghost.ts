/**
 * The copy of the primitive being moved, shown where it is going.
 *
 * ## Why a ghost and not the real thing moving
 *
 * **Because the model here is a field, not a set of chunks.** The landscape can slide a part
 * by moving three transform uniforms on meshes that already exist, so rm-stacker moves the
 * real part live and puts one entry in its history on pointer-up. This model is a signed
 * distance field folded in a worker and meshed by Surface Nets; moving a part means folding
 * the field again and meshing every vertex of the result. Doing that per pointer-move would
 * re-mesh the whole model sixty times a second, on a phone, and each one of those meshes
 * would be thrown away a frame later.
 *
 * So the part stays where it is and a copy of it follows the finger. The model is not
 * touched until the drag ends, at which point there is exactly one rebuild and exactly one
 * history entry.
 *
 * ## Why the copy is built once and then moved
 *
 * **Because only its position changes.** The ghost is the same primitive as the part, and a
 * drag along one axis cannot change its size — so the mesh is right the moment it is built
 * and stays right for every frame of the drag. Rebuilding it would be paying the whole cost
 * again to produce identical vertices. What the drag costs per frame is a position write.
 *
 * ## Why it is drawn unlit, translucent, and without depth writes
 *
 * **Because it is a proposal, not a fact.** The model on screen is the model; this is what
 * the model would look like if the finger were let go. Unlit keeps it the part's own colour
 * rather than a shaded solid that could be mistaken for a second one; translucent keeps the
 * part underneath visible, so it is obvious that the original has not moved. Depth writes
 * off is what lets two of them overlap without either punching a hole in the other.
 */
import {
  Blending,
  Mesh,
  MeshBasicMaterial,
  BufferGeometry,
  type Scene,
} from "@random-mesh/rmsl/scene";

import type { ChunkMesh } from "@big-mesh-studios/meshing";

import { toGeometry } from "./model-view";

export interface Ghost {
  readonly mesh: () => Mesh | undefined;
  /** Shows a copy of `mesh` at `origin`. Passing undefined removes it. */
  readonly show: (
    mesh: ChunkMesh | undefined,
    origin: { readonly x: number; readonly y: number; readonly z: number },
  ) => void;
  /** Moves the ghost. Separate from `show` because this is what a drag does per frame. */
  readonly moveTo: (origin: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }) => void;
  readonly hide: () => void;
  readonly dispose: () => void;
}

export const createGhost = (scene: Scene): Ghost => {
  let geometry: BufferGeometry | undefined;
  let drawn: Mesh | undefined;

  const release = (): void => {
    if (drawn !== undefined) scene.remove(drawn);
    geometry?.dispose();
    geometry = undefined;
    drawn = undefined;
  };

  const material = new MeshBasicMaterial({});
  material.transparent = true;
  material.blending = Blending.NormalBlending;
  material.depthWrite = false;
  // **Between a half and three-quarters, rather than very faint.** Too faint and the ghost
  // cannot be seen against a dark background, which is most of this application's
  // background; opaque and it stops reading as a proposal and starts reading as a second
  // part. It is also drawn over the model it is a copy of, so it has to hold its own against
  // the model's own shading.
  material.opacity = 0.65;

  return {
    mesh: () => drawn,

    show: (mesh, origin) => {
      release();
      if (mesh === undefined) return;
      const built = toGeometry(mesh);
      if (built === undefined) return;
      geometry = built;
      drawn = new Mesh(built, material);
      drawn.position.set(origin.x, origin.y, origin.z);
      scene.add(drawn);
    },

    moveTo: (origin) => {
      drawn?.position.set(origin.x, origin.y, origin.z);
    },

    hide: release,

    dispose: release,
  };
};
