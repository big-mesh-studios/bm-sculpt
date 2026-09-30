/**
 * A hash map keyed by an integer coordinate triple.
 *
 * Ported from `big-mesh-studios/apps/voxelscape/src/world/coordinate-map.ts`, which
 * has this running in a world that scrolls under a walking player.
 *
 * The reason it is not a `Map` keyed by `"x,y,z"` is the cost of the key. Every
 * lookup on that map allocates a string, joins three numbers into it, hashes it,
 * and — when it collides — compares strings, which is twenty to a hundred times the
 * work of the alternative. Here a lookup takes three integers, hashes them without
 * allocating, and compares `Int32Array` entries: a hash and a short linear probe run.
 *
 * The load is in three parallel typed arrays rather than in objects. The keys are
 * `capacity * 3` int32s, the values a plain array so that a stored value can be any
 * type without the map knowing about it, and occupancy a byte a slot — which makes
 * probing three comparisons rather than a property lookup.
 *
 * Two properties this shape implies, which are worth stating because they look like
 * defects until you know otherwise:
 *
 * - **It never shrinks.** A removed entry's slot is reused by the next one that
 *   probes onto it, so the memory a peak demanded is kept for the session. A world
 *   that scrolls holds a *fixed* number of cells, so the peak is known and the table
 *   is sized for it once and never reallocated.
 * - **Removal costs the probe run.** Removing an entry pulls back every entry behind
 *   it whose own probe still reaches the hole, so a delete is `O(probe length)` —
 *   about two slots at half full, and sharply more as the table fills. A table that
 *   is removed from often repays being sized well above what it holds.
 */

export class CoordinateMap<V> {
  private capacity: number;
  private mask: number;
  private count = 0;
  private readonly maxLoadFactor = 0.7;

  private keys: Int32Array;
  private values: Array<V | undefined>;
  private occupied: Uint8Array;

  constructor(initialCapacity = 16) {
    this.capacity = powerOfTwoAtLeast(Math.max(4, initialCapacity));
    this.mask = this.capacity - 1;
    this.keys = new Int32Array(this.capacity * 3);
    this.values = new Array<V | undefined>(this.capacity);
    this.occupied = new Uint8Array(this.capacity);
  }

  /** How many entries the table holds. */
  get size(): number {
    return this.count;
  }

  /** How many slots the table has, which is a power of two. */
  get slots(): number {
    return this.capacity;
  }

  /** The fraction of slots in use, between 0 and 1. */
  get load(): number {
    return this.count / this.capacity;
  }

  /**
   * The value at a coordinate, or undefined when the table holds none.
   *
   * Coordinates are compared as int32, so each has to fit in signed 32 bits. At a
   * 10-unit voxel that is roughly twenty-one million chunks in any direction — far
   * past anything reachable, and bounded rather than approximately true.
   */
  get(x: number, y: number, z: number): V | undefined {
    let slot = this.hash(x, y, z);
    // A probe run stops at the first empty slot, which is why removal has to pull
    // entries back rather than leave a tombstone: anything past a hole would be
    // unreachable.
    while (this.occupied[slot] === 1) {
      const stride = slot * 3;
      if (
        this.keys[stride] === x &&
        this.keys[stride + 1] === y &&
        this.keys[stride + 2] === z
      ) {
        return this.values[slot];
      }
      slot = (slot + 1) & this.mask;
    }
    return undefined;
  }

  /** Whether an entry exists at a coordinate, without reading the value. */
  has(x: number, y: number, z: number): boolean {
    let slot = this.hash(x, y, z);
    while (this.occupied[slot] === 1) {
      const stride = slot * 3;
      if (
        this.keys[stride] === x &&
        this.keys[stride + 1] === y &&
        this.keys[stride + 2] === z
      ) {
        return true;
      }
      slot = (slot + 1) & this.mask;
    }
    return false;
  }

  /** Stores a value at a coordinate, replacing whatever was there. */
  set(x: number, y: number, z: number, value: V): void {
    if (this.count >= this.capacity * this.maxLoadFactor) {
      this.resize(this.capacity * 2);
    }
    let slot = this.hash(x, y, z);
    while (this.occupied[slot] === 1) {
      const stride = slot * 3;
      if (
        this.keys[stride] === x &&
        this.keys[stride + 1] === y &&
        this.keys[stride + 2] === z
      ) {
        this.values[slot] = value;
        return;
      }
      slot = (slot + 1) & this.mask;
    }
    const stride = slot * 3;
    this.keys[stride] = x;
    this.keys[stride + 1] = y;
    this.keys[stride + 2] = z;
    this.values[slot] = value;
    this.occupied[slot] = 1;
    this.count++;
  }

  /**
   * Removes the entry at a coordinate, and reports whether there was one.
   *
   * This is Knuth's Algorithm R for open-addressed deletion. Leaving the hole empty
   * would strand every entry behind it, because a probe run stops at the first empty
   * slot — so the run is walked and any entry whose own probe passes through the
   * hole is pulled down into it.
   *
   * Two details are easy to get backwards, and the first version of this was:
   *
   * - **The hole moves forward only after a move, never on a skip.** An entry whose
   *   probe does *not* come through the hole is left where it is, and the hole stays
   *   put. Setting the hole to a skipped entry would point it at an occupied slot,
   *   and the next entry pulled into it would overwrite a live one. Two entries lost
   *   per hundred deletions is the symptom, and it only shows up in a test that
   *   verifies the whole table rather than the entry just touched.
   *
   * - **The probe-path test runs from the entry's home to the entry itself**, and the
   *   hole has to fall between them. It cannot wrap around forever, because the table
   *   is never full — the load factor grows it before that — and it cannot reach
   *   `target` without first passing the hole, since the entry is found by probing
   *   from its home in the first place.
   */
  delete(x: number, y: number, z: number): boolean {
    let hole = this.hash(x, y, z);
    while (this.occupied[hole] === 1) {
      const stride = hole * 3;
      if (
        this.keys[stride] === x &&
        this.keys[stride + 1] === y &&
        this.keys[stride + 2] === z
      ) {
        break;
      }
      hole = (hole + 1) & this.mask;
    }
    if (this.occupied[hole] === 0) return false;

    this.occupied[hole] = 0;
    this.values[hole] = undefined;
    this.count--;

    let scan = (hole + 1) & this.mask;
    while (this.occupied[scan] === 1) {
      const stride = scan * 3;
      const home = this.hash(
        this.keys[stride],
        this.keys[stride + 1],
        this.keys[stride + 2],
      );
      if (this.probesThrough(home, hole, scan)) {
        // This entry's probe would have stopped at the hole, so it moves down into it
        // and leaves its own slot empty for whatever comes next. `move` copies its
        // first argument into its second, so the live entry is the source.
        this.move(scan, hole);
        hole = scan;
      }
      scan = (scan + 1) & this.mask;
    }
    return true;
  }

  /** Removes everything, keeping the table's capacity. */
  clear(): void {
    this.occupied.fill(0);
    this.values.fill(undefined);
    this.count = 0;
  }

  /** Visits every entry. **In slot order, which is not insertion order.** */
  forEach(fn: (x: number, y: number, z: number, value: V) => void): void {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.occupied[slot] === 0) continue;
      const stride = slot * 3;
      fn(
        this.keys[stride],
        this.keys[stride + 1],
        this.keys[stride + 2],
        this.values[slot] as V,
      );
    }
  }

  /** Every entry as a flat list. Intended for persistence, not for iteration order. */
  entries(): Array<{ x: number; y: number; z: number; value: V }> {
    const out: Array<{ x: number; y: number; z: number; value: V }> = [];
    this.forEach((x, y, z, value) => out.push({ x, y, z, value }));
    return out;
  }

  /** FNV-1a over the three coordinates, folded onto the slot mask. */
  private hash(x: number, y: number, z: number): number {
    let h = 2166136261;
    h = Math.imul(h ^ x, 16777619);
    h = Math.imul(h ^ y, 16777619);
    h = Math.imul(h ^ z, 16777619);
    return (h ^ (h >>> 16)) & this.mask;
  }

  /**
   * Whether a probe run starting at `home` passes through `hole` on its way to
   * `target`.
   *
   * The forward-only scan the table itself does, in integers, with nothing
   * allocated. It terminates because `target` is reached at worst after a full lap,
   * and a full lap cannot happen for an entry that is genuinely stored at `target` —
   * its own probe finds it.
   */
  private probesThrough(home: number, hole: number, target: number): boolean {
    let slot = home;
    while (slot !== target) {
      if (slot === hole) return true;
      slot = (slot + 1) & this.mask;
    }
    return false;
  }

  /** Moves an entry from one slot to another. */
  private move(from: number, to: number): void {
    const fromStride = from * 3;
    const toStride = to * 3;
    this.keys[toStride] = this.keys[fromStride];
    this.keys[toStride + 1] = this.keys[fromStride + 1];
    this.keys[toStride + 2] = this.keys[fromStride + 2];
    this.values[to] = this.values[from];
    this.occupied[to] = 1;
    this.occupied[from] = 0;
    this.values[from] = undefined;
  }

  /** Grows to `newCapacity` and re-inserts every entry through the new mask. */
  private resize(newCapacity: number): void {
    const oldKeys = this.keys;
    const oldValues = this.values;
    const oldOccupied = this.occupied;
    const oldCapacity = this.capacity;

    this.capacity = newCapacity;
    this.mask = newCapacity - 1;
    this.count = 0;
    this.keys = new Int32Array(newCapacity * 3);
    this.values = new Array<V | undefined>(newCapacity);
    this.occupied = new Uint8Array(newCapacity);

    for (let slot = 0; slot < oldCapacity; slot++) {
      if (oldOccupied[slot] === 0) continue;
      const stride = slot * 3;
      this.set(
        oldKeys[stride],
        oldKeys[stride + 1],
        oldKeys[stride + 2],
        oldValues[slot] as V,
      );
    }
  }
}

const powerOfTwoAtLeast = (value: number): number => {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
};
