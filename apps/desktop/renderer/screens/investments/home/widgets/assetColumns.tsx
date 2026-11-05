// Column classes of the Aktywa / Obserwowane tables (ab24ab6 index.css): `.c-inst` 36 % with an ellipsizing name,
// `.c-hint` 168px (cell padding-left 4px), and the 30-day / Wynik columns that give way when the table is narrow:
// `#inv-assets` container below 1000px (`@container (max-width: 999px)`, wins like the old id selector), the
// <= 1180px split, shown again on a portrait monitor wider than 900px.

export const cInst = "w-9/25 max-w-0";
export const cHint = "w-42";
export const cHintTd = "pl-1";
export const cNarrowHidden = "max-wide:hidden min-split:portrait:table-cell @max-[1000px]:hidden!";
/** `.split .main table td:not(:first-child)` at <= 1180px. */
export const splitNowrap = "max-wide:[&_td:not(:first-child)]:whitespace-nowrap";
