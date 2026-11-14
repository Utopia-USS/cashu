/** Python `bisect` over sorted arrays (ISO dates compare as strings). */

/** `bisect.bisect_right(items, x)`: the insertion point after any entries equal to `x`. */
export function bisectRight<T extends string | number>(items: readonly T[], x: T): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < (items[mid] as T)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** `bisect.bisect_left(items, x)`: the insertion point before any entries equal to `x`. */
export function bisectLeft<T extends string | number>(items: readonly T[], x: T): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((items[mid] as T) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
