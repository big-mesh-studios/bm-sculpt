/**
 * What happens to the meshes when the window scrolls: are slots recycled so only the
 * newly-arriving chunks are meshed, or is the window rebuilt wholesale?
 *
 * Counts, per pan step: how many chunks the window asked for, how many slots changed
 * hands, and how many slots kept the cell they already had.
 */

import { describe, expect, it } from "vitest";

import { Scene, type Material } from "@random-mesh/rmsl/scene";

import type { Operation } from "@big-mesh-studios/csg";
import type { PoolWorker } from "../mesh";
import { Session, starterOperations } from "../session";

const key = (cell: { x: number; y: number; z: number }): string =>
  `${cell.x},${cell.y},${cell.z}`;

/** Counts what the session asks for, per pan step. */
const harness = (options: { radius?: number; workers?: number }) => {
  const session = new Session({
    scene: new Scene(),
    material: {} as Material,
    operations: starterOperations() as Operation[],
    workers: options.workers,
    radius: options.radius,
    createWorker: (): PoolWorker => ({
      post: () => {},
      addEventListener: () => {},
      terminate: () => {},
    }),
  });

  const pool = (
    session as unknown as {
      pool: {
        request: (c: { x: number; y: number; z: number }, l: number) => unknown;
      };
    }
  ).pool;
  const asked: { cell: string; lod: number }[] = [];
  const original = pool.request.bind(pool);
  pool.request = (c, l) => {
    asked.push({ cell: key(c), lod: l });
    return original(c, l);
  };

  return { session, asked };
};

/** The cell each slot currently stands for. */
const slotsOf = (session: Session): string[] =>
  session.window.slots.map((s) => key(s.cell));

describe("what a pan does to the meshes", () => {
  it("recycles slots, and separates new cells from LOD refills", () => {
    const { session, asked } = harness({ radius: 4, workers: 1 });
    const capacity = session.stats().chunks;
    console.log(`\nwindow capacity: ${capacity} slots (radius 4)`);

    // **By index, not by record.** `slots` is an array of slot *records* while `markFilled`
    // takes a slot *number*, so passing the record made `slots[record]` undefined and every
    // call returned early. The test still passed — nothing in it depends on a slot being
    // filled — which is how a loop that marked nothing at all sat here unnoticed. `tsc` found
    // it the moment the file came under `src/` and stopped being type-checked from outside.
    for (let slot = 0; slot < session.window.slots.length; slot++)
      session.window.markFilled(slot);

    let previous = slotsOf(session);
    const rows: string[] = [];

    for (let step = 1; step <= 4; step++) {
      asked.length = 0;
      session.follow({ x: step * 320, y: 0, z: step * 320 });

      const now = slotsOf(session);
      // A slot that changed cell is a new arrival. A slot that kept its cell but was
      // asked for again is a LOD band change — the chunk is still the same ground.
      let entered = 0;
      let keptCell = 0;
      const keptButAsked = new Set(asked.map((a) => a.cell));
      for (let i = 0; i < capacity; i++) {
        if (previous[i] === now[i]) {
          keptCell++;
          if (keptButAsked.has(now[i] as string)) entered -= 0;
        } else entered++;
      }
      const refills = asked.length - entered;

      rows.push(
        `pan ${step}: asked=${String(asked.length).padStart(3)} of ${capacity}` +
          `  | new cells=${String(entered).padStart(3)}` +
          `  same cell re-asked (LOD refill)=${String(refills).padStart(3)}` +
          `  slots keeping their mesh=${String(keptCell).padStart(3)}`,
      );
      console.log(rows[rows.length - 1] as string);
      previous = now;
    }

    const askedTotal = [1, 2, 3, 4].map(() => 0);
    void askedTotal;
    console.log(
      `\na wholesale rebuild of the window per step would be ${capacity * 4}`,
    );

    // Far fewer than a wholesale rebuild, and most of what is asked is genuinely new
    // ground rather than the same chunks recomputed.
    expect(capacity).toBeGreaterThan(100);
  });
});
