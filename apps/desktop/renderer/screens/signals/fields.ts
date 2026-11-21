// The bare form controls of the ported Signals / Alerts screens (ab24ab6 index.css `input`, `select`,
// `textarea`, `.field`, `input.num`, `.sig .decide input`): one class string per control and context, so the
// Views keep the old DOM (a label next to its control) and the effective values.

const face =
  "rounded-control border border-border text-fg focus:border-accent focus-visible:outline-none disabled:opacity-60";

/** Old bare `input` (13px, 5px 9px, chip face); `num` right-aligns tabular digits. */
export const inputCls = (o: { num?: boolean; card?: boolean; field?: boolean } = {}) =>
  `${face} text-sm ${o.field ? "w-full px-2.25 py-1.5" : "px-2.25 py-1.25"} ${o.card ? "bg-surface-raised" : "bg-chip"} ${o.num ? "text-right tabular-nums" : ""}`;

/** Old bare `select` (12px, 4px 8px); inside a `.field` 13px, 6px 9px. */
export const selectCls = (o: { card?: boolean; field?: boolean } = {}) =>
  `${face} ${o.field ? "w-full px-2.25 py-1.5 text-sm" : "px-2 py-1 text-xs"} ${o.card ? "bg-surface-raised" : "bg-chip"}`;

/** Old `textarea` (13px, 6px 9px, full width, vertical resize). */
export const textareaCls = (o: { card?: boolean } = {}) =>
  `${face} w-full resize-y px-2.25 py-1.5 text-sm ${o.card ? "bg-surface-raised" : "bg-chip"}`;
