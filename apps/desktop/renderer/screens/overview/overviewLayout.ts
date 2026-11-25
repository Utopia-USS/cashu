// The bento of Przegląd (design/desktop/overview/layered-tiles.html): a 12-column grid that closes without holes
// whatever modules are on. Pure: which tiles are present goes in, each tile's spans come out in page order.
//
// At 12 columns (above 1180px):
// - the net worth hero takes 8 columns and two rows; its side column holds the first two of budget, surplus,
//   then (when those are missing) the next tiles of the middle row pulled up. One side tile spans both rows,
//   none makes the hero full width and one row tall;
// - the middle row (modules not set up, investments, assets, loans) runs in rows of three (4 columns each);
//   a last row of two takes 6 each, of one the full width;
// - accounts take 8 columns with subscriptions at 4, or the full width without them.
// At 6 + 6 (above 760px) every tile pairs up in page order, a tile left alone takes the full row, the hero and
// the accounts the full row; at one column (760px and below) everything is full width.

export type Span = 4 | 6 | 8 | 12;

export interface BentoCell {
  id: string;
  /** Columns at 12 columns. */
  span: Span;
  /** Two rows tall at 12 columns. */
  tall: boolean;
  /** Columns at the two-column width (6 or 12). */
  half: 6 | 12;
}

export interface BentoInput {
  /** The tiles beside the hero, in order (budget, surplus). */
  side: readonly string[];
  /** The middle row in order (modules not set up, investments, assets, loans). */
  middle: readonly string[];
  /** The bottom row: accounts (always), subscriptions when the budget is set up. */
  bottom: readonly string[];
  /** A full-width tile right after the hero (no module turned on). */
  banner?: string | null;
}

/** The hero first, then every tile in page order with its spans. */
export function bentoLayout(input: BentoInput): BentoCell[] {
  const queue = [...input.side, ...input.middle];
  const side = queue.slice(0, 2);
  const middle = queue.slice(side.length);
  const cells: Omit<BentoCell, "half">[] = [
    { id: "hero", span: side.length ? 8 : 12, tall: side.length > 0 },
  ];
  for (const id of side) cells.push({ id, span: 4, tall: side.length === 1 });
  if (input.banner) cells.push({ id: input.banner, span: 12, tall: false });
  const rest = middle.length % 3;
  middle.forEach((id, k) => {
    const last = k >= middle.length - rest;
    cells.push({ id, span: last ? (rest === 2 ? 6 : 12) : 4, tall: false });
  });
  const [main, ...others] = input.bottom;
  if (main) cells.push({ id: main, span: others.length ? 8 : 12, tall: false });
  for (const id of others) cells.push({ id, span: 4, tall: false });
  return withHalves(cells, new Set(["hero", main ?? "", input.banner ?? ""]));
}

/** The two-column spans: the hero, the accounts and the banner take the row; the rest pair up in page order and
 * a tile left without a partner takes the row too. */
function withHalves(cells: Omit<BentoCell, "half">[], wide: ReadonlySet<string>): BentoCell[] {
  const out: BentoCell[] = [];
  let waiting: BentoCell | null = null;
  for (const cell of cells) {
    if (wide.has(cell.id)) {
      if (waiting) waiting.half = 12;
      waiting = null;
      out.push({ ...cell, half: 12 });
      continue;
    }
    const placed: BentoCell = { ...cell, half: 6 };
    out.push(placed);
    waiting = waiting ? null : placed;
  }
  if (waiting) waiting.half = 12;
  return out;
}
