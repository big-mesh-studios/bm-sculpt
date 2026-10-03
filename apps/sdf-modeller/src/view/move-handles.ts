/**
 * Three arrows standing at the part being moved, drawn over whatever they reach into.
 *
 * ## Why real geometry and not an overlay
 *
 * **Because an overlay would have to be told where the arrows are in three dimensions and
 * would then be the only thing in the picture that is not.** An HTML element positioned
 * from a projected point works, and it costs a projection, a matrix read and a style write
 * per arrow per frame — on the same frame that already has a projection to do for the model.
 * Arrows in the scene are placed by setting a position and a scale, and the renderer puts
 * them where everything else is.
 *
 * ## Why the arrows are scaled rather than sized
 *
 * **So they are the same size on screen at any distance.** A handle of fixed world length
 * is a hairline on a figure seen whole and a fence post when the camera comes in to work on
 * a fingertip. Scaling by the camera's distance makes an arrow a fixed fraction of the
 * canvas height instead, which is the only definition of "big enough to hit" that survives
 * a zoom.
 *
 * ## Why the depth test is off
 *
 * **Because an arrow that goes behind the limb it is moving is not grabbable where it looks
 * grabbable.** The arrows stand at the part's origin, which is inside the part, so the shafts
 * start out buried and only the tips clear the surface. With the depth test on, the part
 * wins and the arrows appear to grow out of it — or, worse, appear not to be there at all
 * until the camera swings round. rm-stacker reaches the same conclusion.
 *
 * It costs correct occlusion, which for a control is the right thing to lose: an arrow drawn
 * over the front of a figure is still pointing at the right place.
 */
import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
} from "@random-mesh/rmsl/scene";

import {
  AXES,
  type ArmOnScreen,
  type Axis,
  type ScreenSize,
  HEAD_LENGTH,
  HEAD_RADIUS,
  projectToScreen,
  SHAFT_RADIUS,
  VIEW_SHARE,
} from "./move-handle";

/**
 * The three axis colours, as rm paints them.
 *
 * **The same three rm-stacker uses, and the same as every other 3D application**, because a
 * red-green-blue axis convention is one a person has already learned; a modeller that
 * invented its own would be asking to be taught something for no gain.
 */
const AXIS_COLOUR: Record<Axis, number> = {
  x: 0xe0584c,
  y: 0x6fbf4a,
  z: 0x4a86e0,
};

/** How much bigger the arrow being dragged is drawn. */
const HELD_SCALE = 1.15;

/**
 * One arrow: a shaft with a head on it, standing along its own axis.
 *
 * **Built standing on Y and then turned onto its axis**, rather than built lying down, so
 * there is one geometry pair instead of three of each.
 */
const buildArm = (axis: Axis): Group => {
  const arm = new Group();
  const material = new MeshBasicMaterial({
    color: new Color(AXIS_COLOUR[axis]),
  });
  material.depthTest = false;

  const shaftLength = 1 - HEAD_LENGTH;
  const shaft = new Mesh(
    new CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, shaftLength, 8),
    material,
  );
  shaft.position.set(0, shaftLength / 2, 0);

  const tip = new Mesh(
    new ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 10),
    material,
  );
  tip.position.set(0, shaftLength + HEAD_LENGTH / 2, 0);

  arm.add(shaft, tip);

  // A quarter turn onto X, and the other way for Z. `-90°` about Z takes +Y onto +X.
  if (axis === "x")
    arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  if (axis === "z")
    arm.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);

  return arm;
};

export interface MoveHandles {
  readonly group: Group;
  /**
   * Stands the arrows at `origin`, each `VIEW_SHARE` of the camera's distance long.
   *
   * **Along the model's own axes, and never the part's.** A move tool that followed the
   * part's turn would send a limb sliding along its own length when it was laid on its side,
   * which is the opposite of what "move it over there" means. The model has no parent
   * transform, so its axes and the world's are the same thing and no further choice arises.
   */
  readonly place: (
    origin: { readonly x: number; readonly y: number; readonly z: number },
    radius: number,
  ) => void;
  /** Where each arrow lies on a canvas `size` big, seen through `camera`. */
  readonly armsOnScreen: (
    camera: PerspectiveCamera,
    size: ScreenSize,
  ) => readonly ArmOnScreen[];
  /** How long an arrow is in the world as of the last `place`. A drag reads this. */
  readonly armLength: () => number;
  /** Draws the arrow for `axis` larger, to show it is the one being dragged. */
  readonly setHeld: (axis: Axis | undefined) => void;
  readonly setVisible: (visible: boolean) => void;
  readonly dispose: () => void;
}

export const createMoveHandles = (scene: Scene): MoveHandles => {
  const group = new Group();
  const arms = AXES.map((axis) => {
    const arm = buildArm(axis);
    group.add(arm);
    return { axis, arm };
  });
  scene.add(group);

  // Reused every frame rather than allocated, because this runs inside the render loop and
  // the arrow count is small enough that the garbage would be the largest thing in it.
  const viewProjection = new Matrix4();
  const worldTip = new Vector3();
  const unitTip = new Vector3();

  let length = 0;
  let held: Axis | undefined;

  return {
    group,

    place: (origin, radius) => {
      // **The camera's distance, and not the model's size.** A part half the size does not
      // want half-size handles: it is being moved with the same finger either way.
      length = VIEW_SHARE * radius;
      group.position.set(origin.x, origin.y, origin.z);
      group.scale.set(length, length, length);
      // **No turn is ever set**, deliberately: see the header on `place`.
      for (const { axis, arm } of arms) {
        arm.scale.setScalar(axis === held ? HELD_SCALE : 1);
      }
    },

    armsOnScreen: (camera, size) => {
      // **The handles are children of the scene, so their world matrices come from the
      // scene's root** — read up the tree rather than off the group alone, or a camera
      // that has moved since the last frame would be measured against a stale picture.
      let root: Object3D = group;
      while (root.parent !== null) root = root.parent;
      root.updateMatrixWorld(true);
      camera.updateMatrixWorld();

      viewProjection
        .copy(camera.projectionMatrix)
        .multiply(camera.matrixWorldInverse);

      const from = projectToScreen(
        new Vector3().setFromMatrixPosition(group.matrixWorld),
        viewProjection,
        size,
      );
      // **Behind the camera: no arms at all**, which also leaves nothing to grab. A point
      // behind the camera projects into the middle of the picture mirrored, so testing each
      // arrow separately would put a handle where none is drawn.
      if (from === undefined) return [];

      const found: ArmOnScreen[] = [];
      for (const { axis } of arms) {
        unitTip.set(
          axis === "x" ? 1 : 0,
          axis === "y" ? 1 : 0,
          axis === "z" ? 1 : 0,
        );
        worldTip.copy(unitTip).applyMatrix4(group.matrixWorld);
        const to = projectToScreen(worldTip, viewProjection, size);
        if (to !== undefined) found.push({ axis, from, to });
      }
      return found;
    },

    armLength: () => length,

    setHeld: (axis) => {
      if (axis === held) return;
      held = axis;
      for (const entry of arms) {
        entry.arm.scale.setScalar(entry.axis === held ? HELD_SCALE : 1);
      }
    },

    setVisible: (visible) => {
      group.visible = visible;
    },

    dispose: () => {
      scene.remove(group);
    },
  };
};
