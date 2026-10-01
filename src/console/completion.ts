/**
 * Completing a command name as it is typed.
 *
 * Three functions and no DOM, because this is the one part of the console with
 * any real logic in it: what the player half-typed has to rank against every
 * name there is, and the ranking decides which name the arrow keys land on and
 * therefore which command runs. Everything here is a string in and a string
 * list out, so it can be tested exhaustively without a browser, and the input
 * that uses it is a thin shell around it.
 *
 * Ported from `big-mesh-studios`'s `apps/voxelscape/src/ui/Console.tsx`, where
 * these three sat inside the input component.
 */

/**
 * How well `typed` fuzzy-matches `name`: every character of `typed` has to
 * appear in `name` in the same order, and matches that run together or land
 * earlier score higher.
 *
 * `undefined` when `typed` doesn't match at all. There is no partial credit for
 * a name that is missing a character — completing `/clor` to `/clock:speed`
 * would be completing a typo to something the player did not mean.
 */
export const fuzzyScore = (typed: string, name: string): number | undefined => {
  let cursor = 0;
  let streak = 0;
  let score = 0;
  for (const char of typed) {
    const found = name.indexOf(char, cursor);
    if (found === -1) {
      return undefined;
    }
    streak = found === cursor ? streak + 1 : 0;
    score += streak - (found - cursor);
    cursor = found + 1;
  }
  return score;
};

/**
 * The command names that fuzzy-match what is typed — every one of its
 * characters appearing in the name in the same order — ranked best match first,
 * shorter names first among equal matches.
 *
 * Only a *name* is completed, so a line that has reached its arguments has none;
 * one that already spells a name out has none either, unless a longer sibling
 * extends it too and is worth offering alongside it. `/player:fly` offers
 * nothing at three candidates in a row, because the name it names is the name
 * the player has already finished typing.
 */
export const candidatesFor = (
  typed: string,
  names: readonly string[],
): string[] => {
  if (!typed.startsWith("/") || typed.includes(" ")) {
    return [];
  }
  const ranked = names
    .map((name) => [name, fuzzyScore(typed, name)] as const)
    .filter((scored): scored is [string, number] => scored[1] !== undefined)
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.length - nameB.length)
    .map(([name]) => name);
  return ranked.length > 1 ? ranked : ranked.filter((name) => name !== typed);
};

/**
 * `name` cut back to the scope boundary that follows what is already typed, so
 * completing `/cl` against `/clock:speed` reaches `/clock:` and completing that
 * again reaches the whole name. A name with no boundary left to stop at
 * completes in full.
 *
 * The scope is where the choice between sibling commands is made, so tabbing to
 * it stops there rather than picking one: `/player:` alone says "these all set
 * something about the player", and the rest of the name is a second decision
 * the player is better placed to make than a fuzzy ranking.
 */
export const toScopeBoundary = (name: string, typed: string): string => {
  const boundary = name.indexOf(":", typed.length);
  return boundary === -1 ? name : name.slice(0, boundary + 1);
};
