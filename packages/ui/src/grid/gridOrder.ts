// The dashboard grid on thirds (old frontend grid.ts, verbatim behaviour): three columns at 1440, two at
// <= 1180, one at <= 760. Pure: the two-column reading order. At three columns the DOM order is the
// reading order; at two columns wide widgets (span 2 and 3) keep their order and single widgets pair up in
// reading order, so no row is left half empty unless a single widget is the last one (it then spans the row).

export type Span = 1 | 2 | 3;

export interface GridSlot {
  id: string;
  span: Span;
  /** Wide slot that, at two columns, waits until a single widget waiting for its pair is placed. */
  defer?: boolean;
}

/** Order of every slot in the two-column fallback (1-based CSS `order` values) plus the ids of single
 * widgets that end up alone in their row (rendered full width). */
export function twoColumnOrder(slots: readonly GridSlot[]): {
  order: Map<string, number>;
  alone: Set<string>;
} {
  const order = new Map<string, number>();
  const alone = new Set<string>();
  let n = 0;
  let waiting: string | null = null;
  const deferred: string[] = [];
  const flush = () => {
    for (const id of deferred.splice(0)) order.set(id, ++n);
  };
  for (const slot of slots) {
    if (slot.span > 1) {
      if (slot.defer && waiting != null) deferred.push(slot.id);
      else order.set(slot.id, ++n);
      continue;
    }
    if (waiting == null) {
      waiting = slot.id;
      continue;
    }
    order.set(waiting, ++n);
    order.set(slot.id, ++n);
    waiting = null;
    flush();
  }
  if (waiting != null) {
    order.set(waiting, ++n);
    alone.add(waiting);
  }
  flush();
  return { order, alone };
}

/** Order of the split cell's widgets below 900 px, where the main column and the rail become one column:
 * the rail's first `lead` widgets first, then the main column, then the rest of the rail. 1-based. */
export function splitNarrowOrder(
  main: readonly string[],
  rail: readonly string[],
  lead = 2,
): Map<string, number> {
  const ids = [...rail.slice(0, lead), ...main, ...rail.slice(lead)];
  return new Map(ids.map((id, k) => [id, k + 1]));
}
