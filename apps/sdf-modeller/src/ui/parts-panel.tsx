/**
 * The parts list and the primitive picker.
 *
 * ## Why adding a part is a tap on a primitive rather than a dropdown and a confirm
 *
 * **Because the fastest thing a person does in a modeller is add a part**, and every
 * decision between that tap and the part appearing is a decision they make the same way
 * every time. A dropdown puts the nine primitives behind a second tap and a confirm
 * button behind a third; both cost more than the act is worth.
 *
 * **The picker is always visible rather than behind a mode**, because a mode that has to
 * be entered and left is a state the rest of the interface then has to know about — and
 * the thing that gets added is decided by which of nine buttons was pressed, not by what
 * the interface is currently doing.
 */
import { For } from "solid-js";
import type { ShapeType } from "@big-mesh-studios/sdf";

import { MAX_PARTS, type ModelStore } from "../model/model-store";
import { placedPart } from "../model/part";
import type { Part } from "../model/part";
import styles from "./parts-panel.module.css";

/**
 * A new part of the given kind, at the origin.
 *
 * **The default shape for each primitive is a recognisable one.** A capsule is longer than
 * it is wide, a torus is wider than it is tall, and a round box is only visibly round
 * when its fillet is a decent fraction of its extent. Picking arbitrary numbers would give
 * a first part that looks like a mistake.
 */
const defaultShape = (type: ShapeType): Part["shape"] => {
  switch (type) {
    case "Sphere":
      return { type, radius: 0.5 };
    case "Ellipsoid":
      return { type, radius: { x: 0.7, y: 0.5, z: 0.4 } };
    case "Box":
      return { type, len: { x: 0.6, y: 0.6, z: 0.6 } };
    case "RoundBox":
      return { type, len: { x: 0.5, y: 0.5, z: 0.5 }, radius: 0.15 };
    case "Capsule":
      return { type, len: 1.2, radius: 0.35 };
    case "Cone":
      return { type, len: 1, radius: 0.5 };
    case "Cylinder":
      return { type, len: 1, radius: 0.4 };
    case "Torus":
      return { type, majorRadius: 0.6, minorRadius: 0.2 };
    case "HexPrism":
      return { type, len: 1, radius: 0.5 };
  }
};

export function PartsPanel(props: {
  store: ModelStore;
  primitives: readonly ShapeType[];
}) {
  const full = (): boolean => props.store.parts().length >= MAX_PARTS;

  return (
    <section class={styles.panel} aria-label="Parts">
      <h2 class={styles.heading}>Add</h2>
      <div class={styles.picker}>
        <For each={props.primitives}>
          {(primitive) => (
            <button
              type="button"
              class={styles.primitive}
              disabled={full()}
              onClick={() => {
                props.store.add(
                  // **Ids come from the store, not from a counter here.** Two capsules are two
                  // parts, so a name would not do — and a counter in this panel could not know
                  // that a file just opened with `part-1` in it. See `ModelStore.nextId`.
                  placedPart(props.store.nextId(), defaultShape(primitive), {
                    x: 0,
                    y: 0,
                    z: 0,
                  }),
                );
              }}
            >
              {primitive}
            </button>
          )}
        </For>
      </div>

      <h2 class={styles.heading}>
        Parts
        <span class={styles.count}>{props.store.parts().length}</span>
      </h2>

      <ul class={styles.list}>
        <For each={props.store.parts()}>
          {(part) => (
            <li class={styles.item}>
              <button
                type="button"
                class={
                  props.store.selected() === part.id
                    ? `${styles.select} ${styles.selected}`
                    : styles.select
                }
                onClick={() => {
                  props.store.select(part.id);
                }}
              >
                <span class={styles.kind}>{part.shape.type}</span>
                <span class={styles.coords}>
                  {round(part.origin.x)}, {round(part.origin.y)},{" "}
                  {round(part.origin.z)}
                </span>
              </button>
              <button
                type="button"
                class={styles.remove}
                aria-label={`remove ${part.id}`}
                onClick={() => {
                  props.store.remove(part.id);
                }}
              >
                ×
              </button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** One decimal place, because a coordinate readout with nine is unreadable on a phone. */
const round = (value: number): string => value.toFixed(1);
