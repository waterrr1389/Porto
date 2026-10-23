// Reorders dictionary data by the user's priority list. Titles that are not
// imported are simply absent from the items and therefore ignored.

/**
 * Items named in `priority` come first, in that order; everything else keeps
 * its original (import) order. A title listed twice keeps its first position.
 */
export function orderByPriority<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  priority: readonly string[],
): T[] {
  const rank = new Map<string, number>();
  for (const [index, name] of priority.entries()) {
    if (!rank.has(name)) rank.set(name, index);
  }
  const ranked: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (rank.has(keyOf(item))) ranked.push(item);
    else rest.push(item);
  }
  ranked.sort((a, b) => (rank.get(keyOf(a)) as number) - (rank.get(keyOf(b)) as number));
  return [...ranked, ...rest];
}
