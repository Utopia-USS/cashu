// The compact widget table of the old Home (index.css:569-592 `.w table`, `.w th`, `.w td`, `.num`, the flush
// first / last cell padding, `.w tr.rowlink`, `.w tr.sum`): class strings shared by every widget table.

/** `.w table` (13px, collapsed, no rule under the last row); `flush` = `.wb.flush` first / last cells at 16px. */
export const tableCls = (flush: boolean): string =>
  `w-full border-collapse text-sm [&>tbody>tr:last-child>td]:border-b-0 ${
    flush
      ? "[&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4"
      : ""
  }`;

const cell = "border-b border-border px-2 py-1.75 align-middle";
const align = (num: boolean) => (num ? "text-right tabular-nums whitespace-nowrap" : "text-left");

/** `.w th` (muted 11px uppercase .05em, 600, nowrap); `num` = `th.num`. */
export const thCls = (num = false): string =>
  `${cell} ${align(num)} whitespace-nowrap text-2xs font-strong uppercase tracking-label text-fg-muted`;
/** `.w td`; `num` = `td.num` (right, tabular, nowrap). */
export const tdCls = (num = false): string => `${cell} ${align(num)}`;
/** `.w tr.rowlink`: pointer, the cells (and the ticker tile's surface) on the chip fill while hovered / focused. */
export const rowLinkCls =
  "cursor-pointer hover:[--tile-bg:var(--color-chip)] focus-within:[--tile-bg:var(--color-chip)] [&:hover>td]:bg-chip [&:focus-within>td]:bg-chip";
/** `.w tr.sum td`: muted 12.5px. */
export const sumRowCls = "[&>td]:text-xs-plus [&>td]:text-fg-muted";
/** `.w .empty`: centred muted 13px, padding 18px 12px. */
export const emptyCls = "px-3 py-4.5 text-center text-sm text-fg-muted";
/** `code` (0.92em monospace, no ligatures). */
export const codeCls = "font-mono text-xs [font-variant-ligatures:none]";
/** `.pos` / `.neg` / `.muted` / `.warn` text tones. */
export const toneCls = {
  positive: "text-positive",
  negative: "text-negative",
  muted: "text-fg-muted",
  warning: "text-warning",
} as const;
export type Tone = keyof typeof toneCls;
