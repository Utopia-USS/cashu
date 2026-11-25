// The layout-only vocabulary a caller may pass to a packages/ui component through its `layout` prop
// (cashu-ui skill, references/styling.md). Identity classes (`text-*`, `bg-*`, padding) are a type
// error here; they come from the component's variants.

/** The spacing steps of the 4-point scale (`--spacing: 4px` in theme.css). The class lint's
 * off-scale rule (tools/arch/eslint.config.js) is checked against this list by a guard test. */
export const SPACING_STEPS = ["0", "1", "2", "3", "4", "5", "6", "8"] as const;
export type Step = (typeof SPACING_STEPS)[number];

type Side = "m" | "mx" | "my" | "mt" | "mb" | "ms" | "me";

export type LayoutClass =
  | `${Side}-${Step}`
  | "flex-1"
  | "grow"
  | "shrink"
  | "shrink-0"
  | "basis-0"
  | "self-start"
  | "self-center"
  | "self-end"
  | "self-stretch"
  | "w-full"
  | "min-w-0";

export type Layout = LayoutClass | readonly LayoutClass[];

/** The class string for a `layout` prop, appended to a variant's `class` slot. */
export function layoutClass(layout?: Layout): string {
  if (layout == null) return "";
  return typeof layout === "string" ? layout : layout.join(" ");
}
