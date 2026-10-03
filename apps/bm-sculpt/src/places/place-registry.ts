/**
 * A place is a named group of operations, and this is where that is decided.
 *
 * ## The problem
 *
 * Everything in this application that reads the world reads one thing: a list of
 * operations, folded in index order, into a single signed distance field. The mesher
 * evaluates it, the picker traces it, the player collides with it, and ADR 0009's whole
 * point is that they cannot disagree. That is a good design and it is not the constraint
 * here.
 *
 * The constraint is that `Operation` has one field for identity and it is `index` — a
 * number that means *position in the fold* and nothing else. There is no name, no
 * owner, no parent, no tag. So the questions a place has to answer are all unanswerable:
 *
 * - "Which operations did the script make?" — there is no way to ask.
 * - "Load a second place." — the only way to put operations in the list is
 *   `SculptDocument.add`, and the only way to take them out is undo, which is a stack
 *   and not a name. A second place either lands on top of the first or destroys it.
 * - "Undo must not remove the bridge." — `document.undo()` pops the last command. With a
 *   place's five thousand operations in that stack, one ctrl-z either deletes the entire
 *   place or is blocked from touching anything at all.
 *
 * ## The decision
 *
 * **A place owns its own `Operation[]`, and `flatten` concatenates the owners' lists in
 * allocation order into the one list everything else reads.**
 *
 * That is it. There is no per-place field, no per-place BVH, and no change to
 * `foldOperations` — which `README.md` calls "the one piece of arithmetic that has to be
 * exactly right", and which this deliberately does not touch.
 *
 * The consequence worth stating: **a place is not in the history.** Its operations never
 * enter `document.undoStack`, so undo cannot reach them and ctrl-z cannot delete a place
 * by accident. Removing a place is a named act, not an undo. This falls out of the design
 * rather than being enforced by it, which is the main reason to prefer it.
 *
 * ## Why not the alternatives
 *
 * *Recorded in full in ADR 0016.* In short: an `owner` field on `Operation` costs eight
 * bytes forever on a field the fold never reads and forces a serialiser version bump; a
 * place-as-a-range in the document's list breaks the moment a place grows between two
 * hand edits, because its operations stop being contiguous; and a `Field` per place means
 * composing them, which is the change to the fold this avoids.
 *
 * ## What this does not do
 *
 * Nothing here runs a script. `createQuickJSSandbox` (ADR 0015) is the interpreter and
 * `PlaceRegistry` is the thing a script's effects will eventually land in; the two are
 * not yet connected, and nothing in this file knows an interpreter exists. What is here
 * is the noun the rest of the work hangs off, deliberately built first because every
 * handle, effect and event needs an owner and nothing could be written before one did.
 */

import { makeOperation } from "@big-mesh-studios/csg";
import type { Combine, Operation, OperationShape } from "@big-mesh-studios/csg";
import type { Quat, Vec3 } from "@big-mesh-studios/core";
import { boundsOf, type Bounds } from "../edit/document";
import type { FoldOrder } from "../edit/fold-order";

/**
 * The most operations one place may hold.
 *
 * **Chosen from a measurement, and the measurement is in
 * `place-registry.test.ts`.** Sampling one chunk is `(CHUNK_VOXELS + 2 * FIELD_BORDER)³`
 * = 39,936 field evaluations, and what that costs is driven by *how many operations
 * overlap the chunk* rather than how many exist — so the sweep packs every operation
 * inside the sampled region, which is the worst a place can be. A place that scattered
 * its shapes over a kilometre would cost far less per operation, and measuring that way
 * would flatter this number.
 *
 * One sweep of a chunk's worth of samples, on this machine, run on its own rather than
 * as part of the suite — where the same sweep is three and a half times slower because
 * every file runs in parallel, which is why the test that checks this asserts a *ratio*
 * against a 310-operation model rather than a number of milliseconds:
 *
 * | operations | ms | share of the 2,500 ms ceiling |
 * | ---------- | -- | ----------------------------- |
 * | 310 — a session's worth, that file's model | 144 | 6 % |
 * | 1,000 | 637 | 25 % |
 * | **2,000** | **1,218** | **49 %** |
 * | 4,000 | 3,893 | over |
 * | 8,000 | 10,855 | over |
 *
 * Superlinear — roughly n^1.3 — because the candidate set per sample grows with the
 * cluster, so the fold does more work per sample as well as being asked for more
 * samples' worth of candidates. Two thousand is the last round number inside the
 * ceiling with room and the first over it is four thousand, so there is no argument to be
 * had about where the boundary is — and in the ratio the test asserts, two thousand is
 * about 7x a session's worth while four thousand is about 27x, which straddles the 20x
 * line. So a limit raised without measuring fails rather than merely slows.
 *
 * It is also about as big as a place can usefully be: enough for a script to build a
 * landscape out of primitives, far past anything a person would hand-sculpt, and low
 * enough that a script cannot assemble a model the editor could not also have reached by
 * hand. A script that wants more is a script that wants a mesh format, which is a
 * different feature with a different cost model.
 *
 * **Refused rather than truncated.** `PlaceHandle.add` returns undefined at the limit, so
 * a script that hits this gets an error naming the limit and stops — a thing a person
 * can fix. A silently truncated place is a world with a missing bridge and nothing to
 * say why.
 */
export const MAX_OPERATIONS_PER_PLACE = 2000;

/** A named group of operations, as a caller holds it. */
export interface PlaceHandle {
  /**
   * The name, and the only identity a place has.
   *
   * Supplied by the caller rather than generated, and that is not a stylistic
   * preference. Under the multiplayer model every peer runs every place and derives the
   * same operation list rather than receiving it (ADR 0015), so an id this peer invented
   * would be a different id on every peer — and N copies of every shape. A generated id
   * is the one decision that cannot be made correctly here.
   */
  readonly name: string;
  /** How many operations it holds. */
  readonly count: number;
  /** The world box they reach, for the invalidation a change to them implies. */
  readonly bounds: Bounds | undefined;
  /**
   * Puts one operation in under an id the caller chose, and returns it as the fold will
   * see it.
   *
   * **The id is supplied, never generated**, for the same reason the place's name is: an
   * id this peer invented would be a different id on every peer. It is also what makes
   * `remove` possible — a shape is addressed by what the script called it, which is the
   * only thing the script can still know about after a step boundary.
   *
   * Replacing an existing id is refused rather than allowed: two peers must not be able
   * to disagree about whether an id means the first shape or the second, and "the second
   * one wins" would be exactly that disagreement. Returns undefined if the place is full
   * *or* the id is taken, so a caller checks one thing.
   */
  add(id: string, operation: Operation): Operation | undefined;
  /** Whether that id is already taken in this place. */
  has(id: string): boolean;
  /**
   * Takes one shape out by id.
   *
   * **The operation's index is not reused and its neighbours do not move**, which is what
   * `fold-order.ts` requires: an index is a position in the fold and a recycled one would
   * put a later shape where a removed one used to be, changing the surface silently. So
   * this leaves a hole in the index space, which is fine — indices only have to increase,
   * not to be contiguous.
   *
   * Returns whether there was one, so a caller can tell a no-op from a removal.
   */
  remove(id: string): boolean;
  /** The ids held, in the order they were added. */
  ids(): readonly string[];
  /** Whether this place is over `MAX_OPERATIONS_PER_PLACE`. */
  readonly full: boolean;
}

/**
 * One place's operations, by the ids their creator gave them.
 *
 * A `Map` rather than an array because a shape has to be removable by id, which an array
 * cannot do without a second structure kept in step with it. `Map` preserves insertion
 * order, so the fold order is still "the order things were made" — but that is now a
 * *stated* consequence of the `Map` contract rather than of array indices, which is why
 * `flatten` sorts by the operation's own `index` anyway.
 */
interface Place {
  readonly name: string;
  readonly byId: Map<string, Operation>;
  /**
   * The view handed to callers.
   *
   * Built once and kept, because a handle is something a caller holds and
   * `create`/`get` must be talking about the same object — `create(a) === create(a)` is
   * how a caller can tell it is looking at one place rather than two views of it. It
   * closes over `name` and `operations` rather than over the `Place`, so building it does
   * not need the `Place` and there is no cycle to initialise in the wrong order.
   */
  readonly handle: PlaceHandle;
}

/**
 * Everything that owns operations, and the one list the world is built from.
 *
 * Holds the document's list plus each place's, and knows the order they concatenate in.
 * It does **not** hold the document — it takes the list as an argument — because the
 * document is the *other* kind of owner and this is a place's registry; making it know
 * about the document as well would make it the place where both are represented, and
 * neither of them would then be able to change without it changing.
 */
export class PlaceRegistry {
  /** Places in the order they were created, which is the order they fold in. */
  private readonly inFoldOrder: Place[] = [];
  private readonly byName = new Map<string, Place>();

  constructor(private readonly indices: FoldOrder) {}

  /**
   * The names, in the order they fold.
   *
   * Read off the ordered array rather than off `byName`, even though a `Map` preserves
   * insertion order too: relying on that for a *semantic* ordering is the kind of thing
   * that survives one refactor and then does not. An explicit array makes the fold order
   * a stated fact, and `flatten` reads it directly.
   */
  get names(): readonly string[] {
    return this.inFoldOrder.map((place) => place.name);
  }

  /** How many places exist, empty or not. */
  get count(): number {
    return this.inFoldOrder.length;
  }

  /** Whether anything is there to fold. */
  get empty(): boolean {
    return this.inFoldOrder.length === 0;
  }

  /**
   * Creates a place, or returns the one already under that name.
   *
   * Idempotent by name rather than throwing, because a script that runs its setup twice
   * — once on load, once on a re-entry event — should not take the place down with it.
   * The returned handle is the same either way, and `add` continues the existing place.
   */
  create(name: string): PlaceHandle {
    const existing = this.byName.get(name);
    if (existing !== undefined) return existing.handle;

    const byId = new Map<string, Operation>();
    const place: Place = { name, byId, handle: this.handleFor(name, byId) };
    this.byName.set(name, place);
    this.inFoldOrder.push(place);
    return place.handle;
  }

  /**
   * The place under that name, or undefined.
   *
   * The same object `create` returned.
   */
  get(name: string): PlaceHandle | undefined {
    return this.byName.get(name)?.handle;
  }

  /** Whether a place of that name exists. */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Takes a place out of the fold entirely.
   *
   * The operations go with it, and nothing is left behind in the document — which is the
   * point of the design and the reason a place is not in the history. Returns whether
   * there was one, so a caller can tell a no-op from a removal without asking twice.
   */
  remove(name: string): boolean {
    const place = this.byName.get(name);
    if (place === undefined) return false;
    this.byName.delete(name);
    // Spliced out rather than blanked, and a recreated name lands *last* rather than
    // back where it was. That is deliberate: restoring it to position would hand out
    // indices below the ones its predecessor used, which the fold cannot express (see
    // `fold-order.ts`) and which would change the surface rather than reproduce it.
    const at = this.inFoldOrder.indexOf(place);
    this.inFoldOrder.splice(at, 1);
    return true;
  }

  /** Empties one place, leaving the place itself. */
  clear(name: string): boolean {
    const place = this.byName.get(name);
    if (place === undefined) return false;
    place.byId.clear();
    return true;
  }

  /** Takes every place out. */
  clearAll(): void {
    this.byName.clear();
    this.inFoldOrder.length = 0;
  }

  /**
   * The one operation list the world is built from.
   *
   * **This is the function that decides the fold order, and the only place it is
   * decided.** Every reader of the operation list goes through here — the main thread's
   * field, the model sent to the workers, the live preview — so there is one answer to
   * "what order does this fold in" rather than one per call site.
   *
   * **The order is by index, and that is not the same as "document first".** Two
   * separate things read this list and they used to want different orders:
   *
   * - The **fold** — `foldOperations`, over candidates that `bvh.ts` sorts with
   *   `byIndex`, commented "List order, which is the order the fold has to run in",
   *   because the combine is a smooth minimum: symmetric, not associative. So the fold
   *   order is *index* order whatever this function returns.
   * - **Paint resolution** — `bvh.evalPaint` gives the colour to the operation whose own
   *   surface is *nearest* the point, and settles a tie by list order. So for the
   *   coincident surfaces this document is about, *this function's* order is what decides
   *   which paint wins.
   *
   * Concatenating document-then-places made those two disagree: a place that kept
   * building would sit at the end of the list while holding indices above the document's
   * later ones, so the field would fold chronologically and resolve colour by owner. A
   * user painting over a script's painted wall would lose, because the script's
   * operations came later in the list despite having been made first. Sorting makes list
   * order and index order the same order, so the surface and its colour agree and both
   * are chronological.
   *
   * **Sorted rather than merged**, because each source is *usually* sorted but not
   * always: `SculptDocument.add` trusts its caller's indices, so a deserialised model
   * appended to a non-empty document can arrive out of order. Sorting is what makes the
   * invariant hold regardless of what a caller passed, and `Array.prototype.sort` has been
   * stable since ES2019, so equal indices still resolve the same way on every peer.
   *
   * The document goes in first and places follow in creation order so that equal indices
   * have a defined winner — which is also chronological, because `FoldOrder` hands out
   * indices in the order things are actually made.
   */
  flatten(document: readonly Operation[]): readonly Operation[] {
    // The document's own array when there is nothing to add — not a copy, and not cast
    // to a mutable one to pretend it is a fresh list. No caller mutates what it gets
    // back (`OperationBVH.set` rebuilds its tree; `Session.setOperations` serialises), so
    // `readonly` is the honest type and the no-places case costs nothing at all.
    if (this.inFoldOrder.length === 0) return document;

    let total = document.length;
    for (const place of this.inFoldOrder) total += place.byId.size;

    const all = new Array<Operation>(total);
    let at = 0;
    for (const operation of document) all[at++] = operation;
    for (const place of this.inFoldOrder) {
      for (const operation of place.byId.values()) all[at++] = operation;
    }
    if (total > 1) all.sort(byIndex);
    return all;
  }

  /**
   * How many operations every place holds together, for a readout and for the ceiling
   * the mesher is measured against.
   */
  get operationCount(): number {
    let total = 0;
    for (const place of this.inFoldOrder) total += place.byId.size;
    return total;
  }

  private handleFor(name: string, byId: Map<string, Operation>): PlaceHandle {
    const indices = this.indices;
    return {
      name,
      get count(): number {
        return byId.size;
      },
      get bounds(): Bounds | undefined {
        return boundsOf([...byId.values()]);
      },
      get full(): boolean {
        return byId.size >= MAX_OPERATIONS_PER_PLACE;
      },
      has(id: string): boolean {
        return byId.has(id);
      },
      ids(): readonly string[] {
        return [...byId.keys()];
      },
      add(id: string, operation: Operation): Operation | undefined {
        if (byId.size >= MAX_OPERATIONS_PER_PLACE || byId.has(id))
          return undefined;
        // The index is assigned here rather than by the caller, for the same reason the
        // name is: it has to come out the same on every peer, and the only thing on this
        // side of the boundary that all the peers share is the order they allocated in.
        // A caller that supplied one could supply a different one, and the fold would
        // put the operation somewhere else on somebody else's machine.
        const indexed = { ...operation, index: indices.allocate() };
        byId.set(id, indexed);
        return indexed;
      },
      remove(id: string): boolean {
        return byId.delete(id);
      },
    };
  }
}

/**
 * Orders operations the way the fold reads them: by position in the fold, not by slot in
 * a list.
 *
 * The same comparison `csg/bvh.ts` makes in its own `byIndex`, for the same reason, and
 * duplicated deliberately — that one sorts a candidate cache of *indexed* operations
 * internal to the BVH, and reaching across into it from here would mean this module
 * depends on the tree's internals to answer a question about its own output. Two lines,
 * written twice, is the cheaper of the two.
 */
const byIndex = (a: Operation, b: Operation): number => a.index - b.index;

/**
 * Builds an operation for a place, without an index.
 *
 * Exists so a script's "add a box here" is one call rather than a `makeOperation` with
 * every field defaulted by the caller. `index` is left at zero and overwritten by
 * `PlaceHandle.add`, which is the only thing that may set it.
 */
export const placeOperation = (
  origin: Vec3,
  shape: OperationShape,
  combine: Combine,
  options: {
    softness?: number;
    orientation?: Quat;
    colour?: { r: number; g: number; b: number };
    opacity?: number;
  } = {},
): Operation => makeOperation(0, origin, shape, combine, options);
