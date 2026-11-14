// Cell classes of the Aktywa / Obserwowane tables (design V5): a sentence-case head row (30px, 12px muted, sortable
// heads as buttons), two-line body rows of about 58px on hairlines, the card's 20px side padding on the first and
// last cell, the hovered row on the subtle fill (the ticker tile's ring gap follows it), and the 30-day column that
// gives way when the card is narrower than 672px (`@max-2xl`).

export const tableCls = "w-full border-collapse text-sm tabular-nums";
const edge = "first:pl-5 last:pr-5";
export const thCls = (num = false) =>
  `h-7.5 px-2.5 align-middle text-xs font-regular whitespace-nowrap text-fg-muted ${edge} ${num ? "text-right" : "text-left"}`;
export const tdCls = (num = false) =>
  `h-14.5 border-t border-border px-2.5 py-1.5 align-middle ${edge} ${num ? "text-right whitespace-nowrap" : "text-left"}`;
/** The sub rows (per account, the watch table's plain rows): 40px, muted 12.5px. */
export const subTdCls = (num = false) =>
  `h-10 border-t border-border px-2.5 align-middle text-xs-plus text-fg-muted ${edge} ${num ? "text-right whitespace-nowrap" : "text-left"}`;
export const rowCls =
  "cursor-pointer transition-colors duration-150 hover:[--tile-bg:var(--color-subtle)] focus-within:[--tile-bg:var(--color-subtle)] [&:hover>td]:bg-subtle [&:focus-within>td]:bg-subtle";
export const cInst = "w-full max-w-0";
export const cSpark = "w-24 @max-2xl:hidden";
/** Two lines in one cell, right-aligned: the bold figure over the muted (or toned) change. */
export const stackCls = "inline-grid justify-items-end gap-px";
export const stackTop = "font-strong text-sm-plus text-fg";
