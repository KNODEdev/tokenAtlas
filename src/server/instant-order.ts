/**
 * `items.sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)))`, in place, parsing each instant once: the meter readers sort
 * thousands of readings, and a comparator that parses both sides spends most of their time in `Date.parse`. Equal instants keep
 * their order (as the stable sort does). With an unparsable instant the comparator itself decides, as before.
 */
export function sortByInstant<T>(items: T[], at: (item: T) => string): T[] {
  const keys = items.map(item => Date.parse(at(item)));
  if (keys.some(key => Number.isNaN(key))) return items.sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)));
  const order = items.map((_, index) => index).sort((a, b) => keys[a]! - keys[b]! || a - b);
  const sorted = order.map(index => items[index]!);
  for (let index = 0; index < sorted.length; index++) items[index] = sorted[index]!;
  return items;
}
