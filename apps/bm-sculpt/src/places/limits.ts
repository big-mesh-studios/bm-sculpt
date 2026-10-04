/**
 * Every bound on what a script may *say*, in one file, each with the reason it has that
 * value.
 *
 * ## Why this file exists
 *
 * An effect arrives from a place script, which is code this repository did not write and
 * which may be arriving from a peer. So every field of every payload is bounded, and
 * **a payload that is out of bounds is dropped whole rather than clamped** — a clamped
 * coordinate is a shape in the wrong place that nobody can explain, whereas a dropped
 * effect is a script with a bug in it and a log line saying so.
 *
 * The bounds live here rather than beside the fields that use them because the two
 * questions are different. *What shape is a colour?* belongs with the colour. *Why is this
 * coordinate allowed to be ten million units out?* belongs with every other coordinate,
 * so that raising one raises all of them and the omission is visible.
 *
 * Every constant here is referenced by a rule in `fields.ts`, and a test asserts that each
 * is. An unreferenced bound is either a limit nothing enforces — the one kind of safety
 * property that is worse than having written nothing — or a limit somebody meant to move
 * and could not find.
 *
 * Bounds that are *not* on a payload are not here. `MAX_OPERATIONS_PER_PLACE` bounds the
 * registry rather than a field, and carries a measurement, so it lives beside the code
 * that enforces it. `MAX_STEP_MS` is the exception and is here anyway, because a place's
 * limits should be readable in one file; `interpreter.test.ts` asserts it agrees with
 * the interpreter's own.
 */

/**
 * The longest a name may be: a place's name, or a shape's id inside one.
 *
 * Names are map keys, appear in every log line, and travel over the wire in every event
 * that mentions them, so an unbounded name is memory and bandwidth a peer can ask for.
 * Sixty-four is the same bound the sibling project uses and is longer than anything a
 * person types.
 */
export const MAX_NAME_LENGTH = 64;

/**
 * How far from the origin a place's geometry may reach, in world units.
 *
 * **Ten million, and the reason is the chunk window rather than the world.** The window
 * is five chunks of 320 units (`GAME_WINDOW`), so geometry beyond a few thousand units is
 * never meshed — but it is still folded, because the operation's box is tested per sample
 * and a box a long way out is cheap. The real reason to bound it is that a coordinate is
 * used in arithmetic, and at `1e9` a distance stops being representable in the float the
 * field carries. Ten million is four orders of magnitude beyond anything reachable and
 * comfortably inside the range where `x - y` is still exact to the millimetre.
 */
export const MAX_COORDINATE = 1e7;

/**
 * The largest a shape's own dimension may be.
 *
 * Smaller than `MAX_COORDINATE` deliberately: a shape ten million units across is not a
 * shape, it is a number, and it defeats the candidate cache in `csg/bvh.ts` because its
 * box overlaps every chunk. A kilometre is larger than the fog's far distance
 * (`FOG_FAR` = four chunks) by a factor of eight, so nothing visible is lost.
 */
export const MAX_SHAPE_SIZE = 1e6;

/**
 * The smallest a shape's own dimension may be.
 *
 * `csg/shapes.ts` has `MIN_RADIUS = 1e-3` and says a shape smaller than that is not a
 * shape. The same floor is used here so a script cannot create an operation the field would
 * treat as degenerate, which would be an operation that costs a box test per sample and
 * produces no surface.
 */
export const MIN_SHAPE_SIZE = 1e-3;

/**
 * How soft an operation's edge may be.
 *
 * `MAX_SOFTNESS` in `csg/operations.ts` is 0.25 and is not advisory: an operation's box is
 * padded by `SOFTNESS_REACH * softness`, and `operationBounds` reads that constant rather
 * than the operation. A softness above 0.25 would make the stored box smaller than the
 * shape's real reach, so a chunk at the boundary would mesh differently from its
 * neighbour — a LOD crack that follows the script rather than the terrain.
 */
export const MAX_SOFTNESS = 0.25;

/** How opaque an operation may be. Above 1 is meaningless; `makeOperation` defaults to 1. */
export const MAX_OPACITY = 1;

/** A colour channel's ceiling, and the only place 255 is written down. */
export const MAX_CHANNEL = 255;

/**
 * The longest text a script may put in the log, a toast, or a billboard.
 *
 * A line of text on a screen. Long enough for a paragraph, short enough that a peer
 * cannot use the console scrollback as a place to put something.
 */
export const MAX_TEXT_LENGTH = 512;

/**
 * The longest a zone's name may be, which is text *and* an identity: a zone is addressed
 * by id and labelled by name, and the two are the same string in the payload.
 */
export const MAX_ZONE_NAME_LENGTH = MAX_NAME_LENGTH;

/**
 * The longest one of a place's script files may be, in characters.
 *
 * **A file, not a whole place.** A place is several files and there is no bound on how many
 * there are, which is deliberate — the number of files is the person's decision and each one
 * is small. This is the bound on a single file, so that one enormous file cannot arrive as a
 * payload from a peer and be transpiled into an enormous program inside an interpreter with
 * a step budget.
 *
 * A hundred thousand characters is roughly three thousand lines, which is a large module by
 * any measure and comfortably more than any of the demo places.
 */
export const MAX_SCRIPT_SOURCE = 100_000;

/**
 * How much source one place may carry altogether, in characters.
 *
 * **A total, and `load-place.ts` is the only thing that enforces it** — `MAX_SCRIPT_SOURCE`
 * above bounds one file, and `MAX_PLACE_FILES` bounds how many there are, so the product is
 * forty million characters of TypeScript arriving into a browser tab that then compiles it with
 * a real `Program` per file. That is not a large place, it is a hang.
 *
 * A million is ten full-size files, which is far more than any place needs and far less than
 * the cap would be if the intent were "whatever fits". It is read from the *decompressed* bytes
 * as each file is read, so the loader never retains more than this however large the archive
 * claims to be — which is also why it is a character count and not a compressed one: a number
 * read off the zip's own header would be a number the zip wrote about itself.
 */
export const MAX_PLACE_SOURCE = 1_000_000;

/**
 * How long a timer may be set for, in milliseconds — about a day.
 *
 * A timer longer than this is a place asking to be woken by something that will not happen
 * in any session anybody will sit through, and the host holds pending timers in memory
 * keyed by id, so an unbounded delay is an unbounded number of live records.
 */
export const MAX_TIMER_MS = 86_400_000;

/**
 * How many timers a place may have outstanding at once.
 *
 * A cap on *live* timers rather than on timers ever created, because a script in a loop
 * could otherwise make millions that are never pending: the ones that have fired are gone,
 * and only the ones waiting are held. Ten thousand is far more than a place needs to
 * express and few enough that the host's table stays small.
 */
export const MAX_PENDING_TIMERS = 10_000;

/**
 * The most zones a place may have.
 *
 * A zone is a box tested against the player's position once a frame, so the cost is
 * proportional to the count: a thousand zones is a thousand box tests per player per
 * frame. A place that wants a thousand triggers is a place that wants a spatial index, and
 * the number here is low enough that no index is needed yet.
 */
export const MAX_ZONES = 256;

/**
 * How many lights may exist at once, across every place.
 *
 * **Far more than are drawn.** `MAX_DRAWN_LIGHTS` in `render/point-lights.ts` is eight, and this
 * is 256 — so a place may keep a far larger set than any frame can show and the host picks the
 * nearest few. The gap is deliberate and it is the same reasoning as `MAX_ZONES`: the cost of a
 * light nobody can see is a sort, while the cost of a limit low enough to need no selection
 * would be a place that cannot light a corridor and a courtyard at once.
 *
 * A cap on the *held* count rather than on lights ever created, for the same reason as
 * `MAX_PENDING_TIMERS`: only the ones currently existing cost anything.
 */
export const MAX_LIGHTS = 256;

/**
 * How far one light may reach, in world units.
 *
 * **A hundred thousand, well inside the four-hundred-thousand far plane.** A light reaching further
 * than anything sensible is a light that costs a term in every fragment of the world and reaches no
 * fragment that is not already past the fog. The same bound as `MAX_ZONE_SIZE`'s cousin
 * `MAX_COORDINATE`, and chosen so that "a light that covers everything" is expressible without being
 * unbounded.
 */
export const MAX_LIGHT_RADIUS = 1e5;

/**
 * How bright one light may be.
 *
 * **Ten, which is about three stops above unity.** Intensity is a multiplier on a falloff already
 * normalised to the light's own radius (`render/point-lights.ts`), so one is a bright light and
 * the useful range is small. Ten exists so a place can make a bonfire rather than being told its
 * fire is exactly as bright as its candle — and no more, because a term that brightens a surface
 * past one stops being a light and becomes a hole in the image.
 */
export const MAX_LIGHT_INTENSITY = 10;

/**
 * How many mediums may exist at once, across every place.
 *
 * **Sixty-four, a quarter of `MAX_ZONES`, and the difference is what a medium does.** A zone is
 * read and produces an event; a medium is read and *moves the player*, so two overlapping ones
 * are not merely ambiguous but produce a frame the person in them has to feel. Sixty-four is far
 * more than a conveyor network needs, and the resolution rule below ("the first whose box holds
 * the point") only stays cheap while the count is small enough that "first" is obvious.
 */
export const MAX_MEDIUMS = 64;

/**
 * How fast a medium may push, in world units per second, on any axis.
 *
 * **Two hundred, which is a little over three times a walking player.** `DEFAULT_PLAYER_CONFIG`
 * walks at 60, so this is a fast belt rather than a gentle one — and it is a ceiling on the
 * *target velocity* the field pulls toward, not on the player's speed, so a place cannot use a
 * medium to make someone move faster than the cap by combining it with a large `speedScale`.
 */
export const MAX_MEDIUM_PUSH = 200;

/**
 * What a medium may multiply a walking player's speed by.
 *
 * **Ten, and the floor is zero.** Zero is the quicksand case and is the reason the field is
 * separate from a push at all: a slow medium and a fast one differ only in this number, and
 * clamping the floor at something above zero would make "slow" mean "slightly slow".
 */
export const MAX_MEDIUM_SPEED_SCALE = 10;

/**
 * The largest a zone's box may be on any axis, in world units.
 *
 * A zone is meant to be a doorway or a platform — tens of units — so this is generous by
 * two orders of magnitude. It bounds the number because the host tests the player's
 * position against every zone and a zone spanning the whole world makes every zone's
 * answer depend on every other.
 */
export const MAX_ZONE_SIZE = 1e5;

/** The most key/value pairs a place may hold, across every scope. */
export const MAX_DATA_KEYS = 256;

/** The longest a data key may be. */
export const MAX_DATA_KEY = 64;

/** The longest a data value's string form may be. */
export const MAX_DATA_STRING = 512;

/**
 * The largest a speed or jump multiplier may be.
 *
 * The player's own `PlayerConfig` has no multiplier field — a script's `player-speed`
 * becomes a host-side override — but ten is already faster than anything a player can
 * react to, and an unbounded one is a NaN waiting for a division.
 */
export const MAX_MOVEMENT_MULTIPLIER = 10;

/**
 * How many players a place's notion of "which player" may name.
 *
 * There is one local player in this build (`src/player/`), and a place running on a peer
 * acts on the player that peer is running. The cap is 1 for now and the field exists so
 * that raising it is a data change rather than a format change.
 */
export const MAX_PLAYERS = 1;

/**
 * The longest a player's identity may be.
 *
 * A player's identity is a peer-supplied identifier, so it is the most untrusted string
 * in the system. It is bounded here and, more importantly, it is only ever compared for
 * equality and never interpolated into a selector, a filename, or a command.
 */
export const MAX_PLAYER_ID_LENGTH = 128;

/**
 * The longest a cause of death may be, for the same reason: it is peer-supplied and ends
 * up in a log and in an event payload.
 */
export const MAX_CAUSE_LENGTH = 64;

/**
 * The longest an event's own id may be, and the longest a producer's may be.
 *
 * An event id is `producer:at:sequence` and has to be unique across peers without a
 * coordinator, so it is assembled rather than generated (see `events.ts`). Bounded because
 * it crosses the wire on every fact and because the log keys on it.
 */
export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_PRODUCER_LENGTH = MAX_PLAYER_ID_LENGTH;

/**
 * The most events the log holds.
 *
 * **Facts are never forgotten** — a peer joining late still needs the whole history for
 * the log to be the same log — so this is not a ring buffer and exceeding it is a refusal
 * rather than an eviction. Four thousand is a long session of a place emitting a fact every
 * few seconds, and a place that needs more is a place that needs summaries.
 */
export const MAX_EVENTS = 4000;

/**
 * The largest a clock multiplier may be.
 *
 * Separate from `MAX_MOVEMENT_MULTIPLIER` because they are different quantities with
 * different reasons to be bounded, and sharing one bound between them would mean raising
 * the speed of a sprint also raises how fast a day passes. A hundred times is a day in
 * twelve seconds, which is as fast as a cycle is usefully watchable; beyond that a script
 * is not animating a sky, it is trying to skip it.
 */
export const MAX_CLOCK_MULTIPLIER = 100;

/**
 * How long one step may run, in milliseconds — the same budget as ADR 0015's sandbox.
 *
 * Repeated here rather than imported so that the *limits* of a place are readable in one
 * file, and so that `effects.ts` can be read without following an import into the
 * interpreter. `interpreter.test.ts` asserts the two agree, so they cannot drift.
 */
export const MAX_STEP_MS = 250;
