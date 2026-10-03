/**
 * Who hands out a position in the fold.
 *
 * An operation's `index` is not an identifier. `src/csg/bvh.ts` sorts candidates by
 * it, commented "List order, which is the order the fold has to run in", because
 * `foldOperations` combines with a **smooth minimum**, which is symmetric but not
 * associative: the order the operations are folded in is the surface, and reordering
 * them changes it. Colour resolution is last-writer-wins for the same reason.
 *
 * So an index has exactly two rules. It must increase monotonically, and it must never
 * be reused — a recycled index would put a new operation in the fold where a removed
 * one used to be, changing the surface under everything around it.
 *
 * **Until places existed, the document's length was the next index,** because a
 * brush stroke was the only thing that allocated and it took
 * `document.count` as its base (`src/edit/brush.ts`). That stops being true the moment
 * a second thing allocates: a place created after the first hundred operations would
 * hand out indices 100 and up, and the user's hundred-and-first stroke would hand out
 * the same ones.
 *
 * Hence one counter, shared, in one place. Every owner of operations — the document,
 * and each place — asks this for a band, and `flatten` then concatenates the bands in
 * allocation order, which is total, deterministic, and the same on every peer running
 * the same place. That last part is the whole reason it is a counter and not a list
 * position: the operation list is *recomputed* on every peer rather than replicated,
 * so anything derived from it has to be reproducible rather than merely correct.
 *
 * Nothing here knows what a place is. It knows only that some things own bands of
 * indices, which is a smaller claim than it looks and is the one `csg/` actually needs.
 */

/** Hands out one position in the fold at a time, to every owner of operations. */
export class FoldOrder {
  private next = 0;

  /** The index the next `allocate` will hand out. */
  get ahead(): number {
    return this.next;
  }

  /**
   * Reserves one index and returns it.
   *
   * One at a time rather than as a band, because the alternative asks every owner to
   * remember to report how far its own reservation went, and an owner that forgets
   * silently reissues indices to its own later operations. A stroke's indices come out
   * contiguous anyway, since this is a counter.
   */
  allocate(): number {
    const index = this.next;
    this.next += 1;
    return index;
  }

  /**
   * Moves the counter above every index in `operations`, without handing out anything.
   *
   * For a list that arrived from somewhere else — a deserialised model, a file, a
   * peer's wire format — whose indices are not this counter's to give. `next` moves to
   * one past the largest, so a later `allocate` cannot collide.
   *
   * **Never lowers the counter.** A document can be reset to a smaller list than the
   * one already handed out, and lowering here would reissue indices that a place
   * above has already claimed. Burning the difference costs nothing: the counter is a
   * number, and nothing reads it but `allocate`.
   */
  reserveThrough(operations: readonly { readonly index: number }[]): void {
    for (const operation of operations) {
      if (operation.index >= this.next) this.next = operation.index + 1;
    }
  }
}
