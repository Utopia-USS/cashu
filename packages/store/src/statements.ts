// Sync statements (events.md 8.11): `device.*` and `lease.*` events belong to the sync layer's device
// registry and fetch lease (`packages/sync/src/devices`). They travel in the same frames as view
// events, but the frame gate reads them from the encrypted log (where their signatures and stream
// positions are), never from the store. The store therefore recognises them and skips them: they are
// neither folded, nor held in `event_log`, nor parked (that would ask the owner to upgrade the app),
// nor rejected. `snapshot.*` (S32) is not defined yet
// and stays parked like any unknown type.

/** Type prefixes of the sync statements the store skips (a subset of the reserved prefixes). */
const SYNC_STATEMENT_PREFIXES = ["device.", "lease."] as const;

/**
 * Whether a wire event is a well-formed sync statement: a statement type, a positive integer version,
 * an eid and an object payload. A malformed one takes the normal path (and is rejected there).
 */
export function isSyncStatement(wire: Readonly<Record<string, unknown>>): boolean {
  const { t, v, i, d } = wire;
  return (
    typeof t === "string" &&
    SYNC_STATEMENT_PREFIXES.some((p) => t.startsWith(p) && t.length > p.length) &&
    typeof v === "number" &&
    Number.isSafeInteger(v) &&
    v >= 1 &&
    typeof i === "string" &&
    i.length > 0 &&
    typeof d === "object" &&
    d !== null &&
    !Array.isArray(d)
  );
}
