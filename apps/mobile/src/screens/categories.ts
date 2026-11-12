// Category colours and the options of the phone's pickers (the payment sheet, triage, the cash sheet).
// A category keeps one colour on every screen: its position in the taxonomy (`budget.CATEGORIES`)
// picks the palette entry, never its rank in a list, so Groceries looks the same on Today, Spending,
// Activity and in every picker, whatever the period or the order of the options.
import { budget } from "@cashu/domain";
import type { CompanionCategoryOption } from "@cashu/store/budget/companion";
import type { CategoryOption, SwatchColor } from "@cashu/ui/native";

/** The category palette's size (`palette-1` .. `palette-22`). */
const PALETTE_SIZE = 22;

const POSITION: ReadonlyMap<string, number> = new Map(budget.CATEGORIES.map((c, i) => [c.key, i]));

/** A colour of the category palette (never a role colour: the donut takes palette entries only). */
export type CategorySwatch = Extract<SwatchColor, `palette-${number}`>;

/**
 * The colour of a category, keyed by its taxonomy position; a key outside the taxonomy (none today)
 * still gets a stable entry from its characters.
 */
export function categorySwatch(key: string): CategorySwatch {
  let index = POSITION.get(key);
  if (index === undefined) {
    index = 0;
    for (const char of key) index = (index * 31 + (char.codePointAt(0) ?? 0)) % PALETTE_SIZE;
  }
  return `palette-${(index % PALETTE_SIZE) + 1}` as CategorySwatch;
}

/** The store's options as category grid cells, in the store's order. */
export function categoryOptionsOf(rows: readonly CompanionCategoryOption[]): CategoryOption[] {
  return rows.map((row) => ({ key: row.key, label: row.label, swatch: categorySwatch(row.key) }));
}
