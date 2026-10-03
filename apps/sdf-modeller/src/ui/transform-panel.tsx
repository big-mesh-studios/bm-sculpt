/**
 * The selected part's transform: where it is and which way it points.
 *
 * ## Why both are here, and why they are not the same control
 *
 * **Because they are two independent facts about a part and the primitives are axis
 * aligned.** Every axial primitive in the table runs along Y (ADR 0025), so a capsule is
 * a standing limb until something rotates it — which makes `orientation` not a refinement
 * of the position but the only way to express a horizontal one at all. A panel with a
 * position and no rotation could not build a figure lying down.
 *
 * ## Why the numbers are read out of the quaternion rather than kept beside it
 *
 **Because the alternative stores Euler angles and builds a quaternion from them, and then
 * the two representations disagree.** Any sequence of rotations that does not commute —
 * which is every sequence a person performs — leaves the angle in the panel no longer being
 * the angle in the model. Here the model holds the quaternion, the panel asks it what the
 * angles are, and the number on screen is always the number in the model.
 *
 * ## Why a slider commits on release rather than on every frame
 *
 * **Because a drag that sends a transform every frame fills the undo history.** The store
 * refuses an edit that changes nothing, but a slider that commits continuously would put
 * one history entry per frame and make ctrl-z useless. The value shown while dragging is
 * local; the store is written once when the drag ends.
 */
import { createSignal, For, Show } from "solid-js";

import { fromEuler, toEuler, type Part } from "../model/part";
import type { ModelStore } from "../model/model-store";
import styles from "./transform-panel.module.css";

/** One axis: a label, a number field, and a slider. */
const Axis = (props: {
  label: string;
  value: number;
  step: number;
  onCommit: (value: number) => void;
}) => {
  // **Local while dragging, committed on release.** See the header.
  const [draft, setDraft] = createSignal<string | null>(null);
  return (
    <label class={styles.axis}>
      <span class={styles.axisLabel}>{props.label}</span>
      <input
        class={styles.number}
        type="number"
        step={props.step}
        value={draft() ?? props.value.toFixed(2)}
        onInput={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          setDraft(null);
          if (Number.isFinite(value)) props.onCommit(value);
        }}
      />
    </label>
  );
};

export function TransformPanel(props: { part: Part; store: ModelStore }) {
  const angles = (): { yaw: number; pitch: number; roll: number } =>
    toEuler(props.part.orientation);

  return (
    <section class={styles.panel} aria-label="Transform">
      <h2 class={styles.heading}>
        {props.part.shape.type}
        <span class={styles.id}>{props.part.id}</span>
      </h2>

      <h3 class={styles.subheading}>Position</h3>
      <For each={["x", "y", "z"] as const}>
        {(axis) => (
          <Axis
            label={axis}
            value={props.part.origin[axis]}
            step={0.05}
            onCommit={(value) => {
              props.store.transform(props.part.id, {
                origin: { ...props.part.origin, [axis]: value },
              });
            }}
          />
        )}
      </For>

      <Show when={isAxial(props.part.shape.type)}>
        <h3 class={styles.subheading}>
          Rotation
          <span class={styles.note}>degrees</span>
        </h3>
        <For each={["yaw", "pitch", "roll"] as const}>
          {(axis) => (
            <Axis
              label={axis}
              value={angles()[axis]}
              step={1}
              onCommit={(value) => {
                // **Rebuilt from the other two current angles, not from the committed
                // ones.** A person setting yaw then roll expects the roll they see to be
                // the roll they get, and composing from the *displayed* values is what
                // makes that true; composing from the stored quaternion each time would
                // make the third field depend on the order the first two were typed in.
                const current = angles();
                props.store.transform(props.part.id, {
                  orientation: fromEuler(
                    (axis === "yaw" ? value : current.yaw) * (Math.PI / 180),
                    (axis === "pitch" ? value : current.pitch) *
                      (Math.PI / 180),
                    (axis === "roll" ? value : current.roll) * (Math.PI / 180),
                  ),
                });
              }}
            />
          )}
        </For>
      </Show>
    </section>
  );
}

/**
 * Whether a primitive's own axes mean anything to rotate.
 *
 * **A sphere, an ellipsoid and a round box do not.** Rotating them is not an error — the
 * model accepts it and the field is unchanged — but it is a control that does nothing,
 * and a panel full of controls that do nothing is a panel nobody trusts. A torus is in the
 * list because rolling it is visible, and so is laying it flat.
 */
const isAxial = (type: Part["shape"]["type"]): boolean =>
  type !== "Sphere" && type !== "Ellipsoid" && type !== "RoundBox";
