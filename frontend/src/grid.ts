// The v2 widget grid on thirds (ia-v2.md section 2): three columns at 1440, two at <= 1180, one at <= 760.
// Pure: the two-column reading order. At three columns the DOM order is the reading order; at two columns
// wide widgets (span 2 and 3) keep their order and single widgets pair up in reading order, so no row is
// left half empty unless a single widget is the last one (it then spans the row).

export type Span = 1 | 2 | 3;
export interface GridSlot {
  id: string;
  span: Span;
  /** Wide slot that, at two columns, waits until a single widget waiting for its pair is placed (the
   * research strip comes after the Alerty + Alokacja pair, research.md 1). */
  defer?: boolean;
}

/** Order of every slot in the two-column fallback (1-based, `order` CSS values) plus the ids of single
 * widgets that end up alone in their row (rendered full width). */
export function twoColumnOrder(slots: GridSlot[]): { order: Map<string, number>; alone: Set<string> } {
  const order = new Map<string, number>();
  const alone = new Set<string>();
  let n = 0;
  let waiting: string | null = null;
  const deferred: string[] = [];
  const flush = () => { for (const id of deferred.splice(0)) order.set(id, ++n); };
  for (const s of slots) {
    if (s.span > 1) {
      if (s.defer && waiting != null) deferred.push(s.id);
      else order.set(s.id, ++n);
      continue;
    }
    if (waiting == null) {
      waiting = s.id;
      continue;
    }
    order.set(waiting, ++n);
    order.set(s.id, ++n);
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
