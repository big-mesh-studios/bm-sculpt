/**
 * A growable typed array, and the only way geometry is accumulated in this project.
 *
 * Both the reference renderers build boxed `number[]` and copy to typed arrays
 * afterwards, which costs eight bytes an entry to hold and a pass over every one of
 * them to convert. A mesher writes one position per surface cell and one index per
 * quad, and the number of surface cells is not known until the surface has been
 * walked — so the accumulation *is* the sizing problem, and it is cheaper to grow
 * than to predict.
 *
 * Doubling, not growing by a constant, for the usual reason: copying on every resize
 * makes filling a buffer quadratic.
 *
 * The `exact` / `array` split at the bottom is not cosmetic and gets used the other
 * way round from the usual. `array` is a **view** — free, and what the GPU uploader
 * wants. `exact` is a **copy**, and what leaves a worker must not be a view: a
 * transferred view would be detached, and a mesh built for a chunk that has since
 * been evicted would come back as a zero-length array.
 */

export class Growable<
  T extends Float32Array | Int16Array | Uint8Array | Uint32Array,
> {
  private buffer: T;
  private length = 0;

  constructor(
    private readonly ctor: new (size: number) => T,
    initial = 512,
  ) {
    this.buffer = new ctor(Math.max(1, initial));
  }

  /** How many elements have been written. */
  get size(): number {
    return this.length;
  }

  /** How many elements can be held without growing. */
  get capacity(): number {
    return this.buffer.length;
  }

  /** How many bytes the written elements occupy. */
  get byteLength(): number {
    return this.length * this.buffer.BYTES_PER_ELEMENT;
  }

  private reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let size = this.buffer.length;
    while (size < needed) size *= 2;
    const grown = new (this.ctor as new (size: number) => T)(size);
    grown.set(this.buffer as never);
    this.buffer = grown;
  }

  /** Appends one value. */
  push(value: number): void {
    this.reserve(1);
    this.buffer[this.length++] = value;
  }

  /** Appends several values. */
  pushMany(values: ArrayLike<number>): void {
    this.reserve(values.length);
    this.buffer.set(values as never, this.length);
    this.length += values.length;
  }

  /** Appends one value repeated `count` times. */
  pushRepeated(value: number, count: number): void {
    this.reserve(count);
    this.buffer.fill(value, this.length, this.length + count);
    this.length += count;
  }

  /** Overwrites a value already written. */
  setAt(index: number, value: number): void {
    if (index >= this.length) {
      throw new Error(
        `index ${index} is past the ${this.length} values written`,
      );
    }
    this.buffer[index] = value;
  }

  /** Reads a value already written. */
  at(index: number): number {
    return this.buffer[index];
  }

  /** Empties it, keeping the buffer for the next mesh. */
  clear(): void {
    this.length = 0;
  }

  /**
   * A **copy** of what has been written, trimmed to its length. For anything that
   * leaves this thread.
   */
  exact(): T {
    return this.buffer.slice(0, this.length) as T;
  }

  /** A **view** of what has been written, with no copy. For the GPU uploader. */
  array(): T {
    return this.buffer.subarray(0, this.length) as T;
  }

  /** The element at an index, for iteration. */
  [Symbol.iterator](): IterableIterator<number> {
    return this.array()[Symbol.iterator]();
  }
}
