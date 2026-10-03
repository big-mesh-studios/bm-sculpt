import { describe, expect, it } from "vitest";

import { CoordinateMap } from "./coordinate-map";

let seed = 0x1f2e3d4c;
const next = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const coordinate = (scale: number): [number, number, number] => [
  Math.floor((next() * 2 - 1) * scale),
  Math.floor((next() * 2 - 1) * scale),
  Math.floor((next() * 2 - 1) * scale),
];

describe("the coordinate map", () => {
  it("reads back what it was given, at negative coordinates too", () => {
    const map = new CoordinateMap<string>();
    map.set(1, 2, 3, "a");
    map.set(-4, -5, -6, "b");
    map.set(0, 0, 0, "c");
    expect(map.get(1, 2, 3)).toBe("a");
    expect(map.get(-4, -5, -6)).toBe("b");
    expect(map.get(0, 0, 0)).toBe("c");
    expect(map.size).toBe(3);
  });

  it("reports a miss for a coordinate it never held", () => {
    const map = new CoordinateMap<string>();
    map.set(1, 2, 3, "a");
    expect(map.get(1, 2, 4)).toBeUndefined();
    expect(map.has(1, 2, 4)).toBe(false);
    expect(map.has(1, 2, 3)).toBe(true);
  });

  it("replaces rather than duplicates", () => {
    const map = new CoordinateMap<string>();
    map.set(5, 5, 5, "first");
    map.set(5, 5, 5, "second");
    expect(map.get(5, 5, 5)).toBe("second");
    expect(map.size).toBe(1);
  });

  it("keeps every entry reachable across tens of thousands of mixed operations", () => {
    // The property a probe table can lose in two ways: a delete stranding an entry
    // behind the hole it left, and a grow rehashing incorrectly. Both would be
    // intermittent — a missing chunk, or a chunk that never comes back — and both
    // took a version of this delete wrong at a rate of about two in a hundred
    // deletions, so the run has to be long enough to hit that comfortably.
    //
    // Twenty thousand operations, verifying the whole table every two thousand.
    // Both numbers are set by what dominates: the verification does a lookup per live
    // entry, so the run's cost grows with its square. Bigger runs would spend their
    // budget on checking rather than on the thing being checked.
    //
    // The explicit timeout is for the same reason. This test's cost depends on the
    // machine, and a fixed global budget would either fail here or be set so high on
    // fast hardware that the run stops being long enough to be worth having.
    const STEPS = 20_000;
    const VERIFY_EVERY = 2_000;

    const map = new CoordinateMap<number>();
    const live = new Map<string, number>();
    let counter = 0;

    for (let step = 0; step < STEPS; step++) {
      const [x, y, z] = coordinate(400);
      const key = `${x},${y},${z}`;

      if (next() < 0.65) {
        const value = counter++;
        map.set(x, y, z, value);
        live.set(key, value);
      } else {
        const expected = live.get(key);
        const removed = map.delete(x, y, z);
        expect(removed, `step ${step} at ${key}`).toBe(expected !== undefined);
        live.delete(key);
      }

      // Periodically verify the whole table, not just the entry just touched. This
      // is the part that catches a stranded entry, since nothing about the sequence
      // of operations would report one.
      if (step % VERIFY_EVERY === 0) {
        expect(map.size, `size at step ${step}`).toBe(live.size);
        for (const [k, v] of live) {
          const [lx, ly, lz] = k.split(",").map(Number) as [
            number,
            number,
            number,
          ];
          expect(map.get(lx, ly, lz), `${k} at step ${step}`).toBe(v);
        }
      }
    }

    expect(map.size).toBe(live.size);
    for (const [k, v] of live) {
      const [lx, ly, lz] = k.split(",").map(Number) as [number, number, number];
      expect(map.get(lx, ly, lz)).toBe(v);
    }
  }, 120_000);

  it("keeps entries reachable when the table has grown and shrunk repeatedly", () => {
    // The worst case for backward-shift deletion is a table that sits near its load
    // factor while entries are removed from its middle, which is exactly what a
    // scrolling window does: it frees cells at one edge and claims them at the other.
    const map = new CoordinateMap<number>();
    const window = 40;
    const held = new Map<string, number>();

    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < window; i++) {
        const value = round * window + i;
        map.set(round * 10, i, -round, value);
        held.set(`${round * 10},${i},${-round}`, value);
      }
      // Free the oldest generation, which is scattered through the table by now.
      const oldest = round - 8;
      if (oldest >= 0) {
        for (let i = 0; i < window; i++) {
          map.delete(oldest * 10, i, -oldest);
          held.delete(`${oldest * 10},${i},${-oldest}`);
        }
      }
    }

    expect(map.size).toBe(held.size);
    for (const [k, v] of held) {
      const [x, y, z] = k.split(",").map(Number) as [number, number, number];
      expect(map.get(x, y, z), k).toBe(v);
    }
  });

  it("reports false when deleting something it never held", () => {
    const map = new CoordinateMap<string>();
    map.set(1, 1, 1, "a");
    expect(map.delete(2, 2, 2)).toBe(false);
    expect(map.size).toBe(1);
  });

  it("empties without giving the table back", () => {
    // The pool's peak is known and paid for once, so clearing should not undo that.
    const map = new CoordinateMap<number>(1024);
    for (let i = 0; i < 500; i++) map.set(i, 0, 0, i);
    const capacity = map.slots;
    map.clear();
    expect(map.size).toBe(0);
    expect(map.slots).toBe(capacity);
    expect(map.get(3, 0, 0)).toBeUndefined();
    // And it is still usable afterwards.
    map.set(9, 9, 9, 42);
    expect(map.get(9, 9, 9)).toBe(42);
  });

  it("grows rather than filling up", () => {
    const map = new CoordinateMap<number>(4);
    const first = map.slots;
    for (let i = 0; i < 500; i++) map.set(i, 0, 0, i);
    expect(map.slots).toBeGreaterThan(first);
    expect(map.load).toBeLessThanOrEqual(0.7);
    for (let i = 0; i < 500; i++) expect(map.get(i, 0, 0)).toBe(i);
  });

  it("sizes its capacity to a power of two", () => {
    // The mask is `capacity - 1` and the probe advances with `& mask`, so a capacity
    // that is not a power of two silently makes some slots unreachable.
    for (const requested of [1, 3, 5, 100, 257]) {
      const map = new CoordinateMap<number>(requested);
      expect(map.slots & (map.slots - 1)).toBe(0);
      expect(map.slots).toBeGreaterThanOrEqual(requested);
    }
  });

  it("visits every entry exactly once, whatever the order", () => {
    const map = new CoordinateMap<string>();
    const expected = new Map<string, string>();
    for (let i = 0; i < 300; i++) {
      const [x, y, z] = coordinate(50);
      const key = `${x},${y},${z}`;
      map.set(x, y, z, key);
      expected.set(key, key);
    }
    const seen = new Map<string, string>();
    map.forEach((x, y, z, value) => {
      expect(seen.has(value)).toBe(false);
      seen.set(value, `${x},${y},${z}`);
    });
    expect(seen.size).toBe(expected.size);
    for (const [key, where] of expected) expect(seen.get(key)).toBe(where);
  });

  it("holds values that are themselves undefined, without confusing them for a miss", () => {
    // A `Map` can store `undefined` as a value and still answer `has`. This one
    // cannot, because the occupied byte is what distinguishes an entry from a miss.
    // Worth knowing rather than discovering: nothing in this project stores
    // undefined, and a value that is undefined is a programming error everywhere
    // else too.
    const map = new CoordinateMap<number | undefined>();
    map.set(1, 1, 1, undefined);
    expect(map.has(1, 1, 1)).toBe(true);
    expect(map.size).toBe(1);
    expect(map.get(1, 1, 1)).toBeUndefined();
  });

  it("handles the extreme coordinates an int32 can hold", () => {
    const map = new CoordinateMap<number>();
    const extremes: Array<[number, number, number]> = [
      [2147483647, 2147483647, 2147483647],
      [-2147483648, -2147483648, -2147483648],
      [2147483647, -2147483648, 0],
    ];
    for (const [i, c] of extremes.entries()) map.set(c[0], c[1], c[2], i);
    for (const [i, c] of extremes.entries())
      expect(map.get(c[0], c[1], c[2])).toBe(i);
  });

  it("stays correct when a small table is churned hard", () => {
    // A small table is where a deletion bug hides worst: the probe runs are long
    // relative to the table, so a hole left in the wrong place strands an entry
    // almost every time. The table starts at its minimum deliberately.
    const map = new CoordinateMap<number>(4);
    const live = new Map<string, number>();
    const columns = 16;
    const rows = 12;

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const value = row * columns + column;
        map.set(column, row, 0, value);
        live.set(`${column},${row},0`, value);
      }
    }
    // Remove every third row, which leaves surviving entries straddling the holes.
    for (let row = 0; row < rows; row += 3) {
      for (let column = 0; column < columns; column++) {
        expect(map.delete(column, row, 0), `${column},${row}`).toBe(true);
        live.delete(`${column},${row},0`);
      }
      for (const [key, value] of live) {
        const [x, y, z] = key.split(",").map(Number) as [
          number,
          number,
          number,
        ];
        expect(map.get(x, y, z), `${key} after removing row ${row}`).toBe(
          value,
        );
      }
    }
    expect(map.size).toBe(live.size);
  });
});
