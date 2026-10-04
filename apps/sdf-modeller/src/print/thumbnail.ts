/**
 * A picture of the model, for the `.3mf` to carry.
 *
 * ## Why a render target rather than a second canvas
 *
 * **Because a second WebGL context is not free and this needs none.** rmsl's
 * `WebGLRenderer.render(scene, camera, target)` redirects a draw into an offscreen colour
 * texture on the *same* context, and `readPixels(target)` pulls it back to the host — sharing
 * the renderer's programs, buffers and textures. A second renderer on a detached canvas would
 * cost a whole context's worth of that for a picture that is 140 pixels across.
 *
 * **A scene of its own, though.** The viewport's scene also holds the move handles and the drag
 * ghost, and a thumbnail with an axis gizmo in it is worse than no thumbnail. So this builds
 * its own `Scene` and its own `Mesh` from the same `ChunkMesh`, which means it can be handed a
 * mesh rather than a scene and knows nothing about what else is on the screen. The geometry is
 * disposed when the picture is taken, and the only cost of that is one upload the export was
 * going to pay for anyway.
 *
 * ## Why the PNG comes from a 2D canvas
 *
 * **Because `canvas.toBlob('image/png')` is the platform's PNG encoder and is already here.**
 * `big-mesh-studios` pulls in `fast-png` for this because it also encodes PNGs in Node, under
 * test, with no canvas. Nothing here does: a thumbnail is produced in a browser at export time
 * or not at all, so a dependency and a hand-written deflate pass would be a hundred kilobytes
 * of first paint for a file format's optional extra. The row flip that `readPixels` leaves to
 * the caller is one `scale(1, -1)`.
 *
 * ## What is not tested here, and why
 *
 * **The GL calls.** jsdom has no WebGL, and a test that mocks a renderer's readback is a test
 * of the mock. `cameraDistanceFor` below is the part with arithmetic in it and is tested; the
 * rest is `render`, `readPixels` and `toBlob`, each of which either works or throws, and a
 * failure throws out of `exportThreeMf` rather than producing a wrong file.
 */
import {
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "@random-mesh/rmsl/scene";
import type { ChunkMesh } from "@big-mesh-studios/meshing";

import { FOV_Y } from "../view/viewport";
import { toGeometry } from "../view/model-view";
import { modelMaterial } from "../view/model-material";
import type { MeshBounds } from "./stand";

/**
 * How many pixels a side the picture is.
 *
 * **A hundred and forty, which is the smallest size that is still a picture.** It is shown as
 * an icon in a file manager and a slicer's file list, both of which draw it at about this size,
 * so a larger one is bytes nobody sees and a smaller one is a blur.
 */
export const THUMBNAIL_SIZE = 140;

/**
 * How far round and how far down the camera looks.
 *
 * **Three-quarters and thirty degrees, which is the turn that shows two sides and the top.**
 * A model lit from one side and seen edge-on is a silhouette; a third of a right angle off the
 * axis is the smallest turn from which a solid reads as a solid rather than as an outline.
 */
const YAW = Math.PI / 4;
const PITCH = Math.PI / 6;

/**
 * How much room to leave around the model, as a fraction of the radius it needs.
 *
 * **A twelfth over, and it is the difference between a model and a model touching the edges of
 * its own picture.** The distance is the radius divided by the sine of half the field of view,
 * which is the distance at which that radius exactly spans the frame; anything under it clips,
 * and a figure editor's silhouette is exactly what somebody recognises their model by.
 */
const BREATHING_ROOM = 1.1;

/**
 * How far back the camera has to be for a model of this box to fit the frame.
 *
 * **The bounding sphere, not the bounding box.** The distance a perspective camera needs is set
 * by the model's *largest* distance from its centre, which is half the box's diagonal — a box
 * test would put a long thin model too close and clip its ends, which is the failure a figure
 * is most often shaped like.
 *
 * @param bounds The model's own box, from `meshBounds`.
 * @param fovYRadians The vertical field of view. Passed rather than imported so a test can put
 *   the camera somewhere absurd and check the arithmetic.
 */
export const cameraDistanceFor = (
  bounds: MeshBounds,
  fovYRadians: number,
): number => {
  const half = {
    x: (bounds.max.x - bounds.min.x) / 2,
    y: (bounds.max.y - bounds.min.y) / 2,
    z: (bounds.max.z - bounds.min.z) / 2,
  };
  const radius = Math.hypot(half.x, half.y, half.z);
  return (radius * BREATHING_ROOM) / Math.sin(fovYRadians / 2);
};

/** The camera the picture is taken from: the model's own three-quarter view, square aspect. */
const pictureCamera = (bounds: MeshBounds): PerspectiveCamera => {
  const camera = new PerspectiveCamera(FOV_Y, 1, 0.01, 8000);
  const centre = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const away = cameraDistanceFor(bounds, (FOV_Y * Math.PI) / 180);

  camera.position.set(
    centre.x + away * Math.cos(PITCH) * Math.sin(YAW),
    centre.y + away * Math.sin(PITCH),
    centre.z + away * Math.cos(PITCH) * Math.cos(YAW),
  );
  camera.lookAt(centre.x, centre.y, centre.z);
  camera.updateProjectionMatrix();

  return camera;
};

/**
 * The model's picture as the bytes of a PNG.
 *
 * @param renderer The viewport's renderer, so this costs no second WebGL context.
 * @param mesh The mesh to photograph, already meshed at print resolution.
 * @param bounds The model's own box, from `meshBounds` over the same mesh.
 * @param size The picture's width and height in pixels.
 * @returns The PNG, or `undefined` where there is no DOM to encode one in.
 */
export const thumbnailFromMesh = async (
  renderer: WebGLRenderer,
  mesh: ChunkMesh,
  bounds: MeshBounds,
  size: number = THUMBNAIL_SIZE,
): Promise<Uint8Array | undefined> => {
  const geometry = toGeometry(mesh);
  if (geometry === undefined) return undefined;

  // **The scene and the mesh are ours and are disposed here**, so a caller hands over a mesh
  // and gets a picture without anything it drew being added to or taken off anything.
  const scene = new Scene();
  const shown = new Mesh(geometry, modelMaterial(false));
  scene.add(shown);

  const target = new WebGLRenderTarget(size, size);
  try {
    renderer.render(scene, pictureCamera(bounds), target);
    return await encodePng(renderer.readPixels(target), size);
  } finally {
    // **Disposed whatever happened.** A geometry and a target left on the renderer are two
    // buffers that nothing will ever free, and this runs on every export.
    scene.remove(shown);
    geometry.dispose();
  }
};

/**
 * The pixels as the bytes of a PNG.
 *
 * **The rows flipped, because `readPixels` hands them back bottom-up.** OpenGL's origin is the
 * bottom left of the framebuffer and a canvas's is the top left, so a picture taken without
 * this is upside down — which for a thumbnail is a model standing on its head, and for a
 * symmetric one is not noticeable at all, which is what makes it the kind of bug that ships.
 */
const encodePng = async (
  pixels: Uint8Array,
  size: number,
): Promise<Uint8Array | undefined> => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (context === null) return undefined;

  const image = context.createImageData(size, size);
  const row = size * 4;
  for (let line = 0; line < size; line++) {
    const from = (size - 1 - line) * row;
    image.data.set(pixels.subarray(from, from + row), line * row);
  }
  context.putImageData(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (blob === null) return undefined;

  return new Uint8Array(await blob.arrayBuffer());
};
