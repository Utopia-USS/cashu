// The plain page table of the Python app (index.css:98-101 global `table`, `th`, `td`, `.num`, `.scroll`,
// `.tall`): class strings for tables outside a widget (Settings logs, drawer previews).

/** `table` (14px, full width, collapsed). */
export const dataTableCls = "w-full border-collapse text-md";
const cell = "border-b border-border px-1.5 py-2";
/** `th` (muted 12px uppercase .03em, 600); `num` = right-aligned tabular. */
export const dataThCls = (num = false): string =>
  `${cell} ${num ? "text-right tabular-nums" : "text-left"} text-xs font-strong uppercase tracking-column text-fg-muted`;
/** `td`; `num` = right-aligned tabular. */
export const dataTdCls = (num = false): string =>
  `${cell} ${num ? "text-right tabular-nums" : "text-left"}`;
/** `.scroll` (horizontal scroll) and `.scroll.tall` (max 360px high, scrolls both ways). */
export const scrollCls = (tall = false): string =>
  tall ? "max-h-90 overflow-auto" : "overflow-x-auto";
