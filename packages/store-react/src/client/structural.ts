// Structural sharing for query snapshots: a new run's value keeps the identity of every part that did
// not change, so `useQuery` consumers (list rows, compiled components) skip work for unchanged rows.
// Plain objects and arrays are shared part by part; other values (Decimal, Money, Date, bytes) are
// compared whole and kept when equal.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `next`, with every part deep-equal to the same part of `prev` replaced by `prev`'s. */
export function replaceEqual<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out = next.map((item, i) => replaceEqual(prev[i], item));
    const same = out.length === prev.length && out.every((item, i) => item === prev[i]);
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = Object.keys(next);
    const out: Record<string, unknown> = {};
    let same = keys.length === Object.keys(prev).length;
    for (const key of keys) {
      const value = replaceEqual(prev[key], next[key]);
      out[key] = value;
      if (!(key in prev) || value !== prev[key]) same = false;
    }
    return (same ? prev : out) as T;
  }
  return (deepEqual(prev, next) ? prev : next) as T;
}

/** Value equality of query results: plain data, class instances by prototype and own fields. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => deepEqual(item, other[i]));
  }
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (ArrayBuffer.isView(a)) {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const other = b as ArrayBufferView;
    const y = new Uint8Array(other.buffer, other.byteOffset, other.byteLength);
    return x.length === y.length && x.every((byte, i) => byte === y[i]);
  }
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>;
    return (
      a.size === other.size && [...a].every(([k, v]) => other.has(k) && deepEqual(v, other.get(k)))
    );
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>;
    return a.size === other.size && [...a].every((v) => other.has(v));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((key) => key in y && deepEqual(x[key], y[key]))
  );
}
