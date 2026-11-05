// The old (ab24ab6) screens read the Python API JSON: integer ids and plain numbers. The native projections
// already carry the same field names (the parity views), but with canonical gids and exact Decimals. This
// boundary turns one into the other for the ported Home and review deck: every Decimal becomes its float, every
// string that IS a gid becomes a small session-stable integer, and the reverse map hands the gid back to the
// native commands. Nothing else is rewritten (rule ids, bucket ids, dedup keys and text stay as they are).
import { Decimal } from "@cashu/domain";

// Actual event v1 identities: keyed UUIDv8 or ULID (the same rule as the parity wire boundary).
const GID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/;

// Append-only for the window's lifetime: a gid keeps its number across reads, so cards, focus and keys built
// from the old ids stay put while the data refreshes. Numbers are never reused.
const numbers = new Map<string, number>();
const gids: string[] = [];

export const isGid = (value: string): boolean => GID.test(value);

/** The legacy integer id of a gid (interned on first sight). */
export function legacyId(gid: string): number {
  const known = numbers.get(gid);
  if (known !== undefined) return known;
  gids.push(gid);
  numbers.set(gid, gids.length);
  return gids.length;
}

/** A nullable gid as the legacy id. */
export const legacyIdOf = (gid: string | null | undefined): number | null =>
  gid == null ? null : legacyId(gid);

/** The gid behind a legacy id; null for an id this window never handed out. */
export function gidOf(id: number | string | null | undefined): string | null {
  if (id == null) return null;
  if (typeof id === "string") return isGid(id) ? id : (gids[Number(id) - 1] ?? null);
  return gids[id - 1] ?? null;
}

/** Hand out numbers in this order first (creation order, oldest first), so legacy tie-breaks on `id` read
 * like the old autoincrement ids. */
export function internInOrder(ordered: readonly string[]): void {
  for (const gid of ordered) legacyId(gid);
}

/** Deep copy with Decimals as floats and gid strings as legacy ids; typed as the old payload `T`. */
export function wire<T>(value: unknown): T {
  return visit(value) as T;
}

function visit(item: unknown): unknown {
  if (item === null || item === undefined) return item;
  if (typeof item === "string") return isGid(item) ? legacyId(item) : item;
  if (typeof item !== "object") return item;
  if (item instanceof Decimal) return item.toFloat();
  if (Array.isArray(item)) return item.map(visit);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(item)) out[key] = visit(entry);
  return out;
}
