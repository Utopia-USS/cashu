// Batched lookups of transaction partitions for the budget derivers: a dirty set can hold every row
// of a bulk import, so registers are read with IN lists of one padded size (one prepared shape).
import type { ViewSql } from "../../engine/types.js";
import type { SqlValue } from "../../sql/driver.js";

const CHUNK = 256;

/**
 * Run `sql` (with one `IN (?...)` placeholder written as `(%IN%)`) over `keys` in chunks and return
 * every row. Padding with NULL keeps a single statement shape. `lead` binds the placeholders before
 * the list.
 */
export function selectIn<R>(
  sql: ViewSql,
  query: string,
  keys: readonly string[],
  lead: readonly SqlValue[] = [],
): R[] {
  if (keys.length === 0) return [];
  const shaped = query.replace("%IN%", Array.from({ length: CHUNK }, () => "?").join(", "));
  const out: R[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk: (string | null)[] = keys.slice(i, i + CHUNK);
    while (chunk.length < CHUNK) chunk.push(null);
    out.push(...sql.all<R>(shaped, ...lead, ...chunk));
  }
  return out;
}
