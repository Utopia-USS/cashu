// Theme-aware colors for the SVG charts: CSS custom properties read off :root and the categorical palette (DOM
// and CSS, so they stay in the app; the number and date formatters live in @cashu/ui-logic/core/format).

/** Read a CSS custom property off :root (theme-aware colors for charts). */
export const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const PALETTE = [
  "#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#ea580c", "#0891b2", "#ca8a04",
  "#db2777", "#4f46e5", "#059669", "#e11d48", "#9333ea", "#f59e0b", "#0ea5e9",
  "#65a30d", "#c026d3", "#14b8a6", "#f43f5e", "#6366f1", "#84cc16", "#a855f7", "#ef4444",
];

/** CSS var name for a net-worth component bucket (see analytics.NW_COMPONENT_ORDER). */
export const nwColorVar: Record<string, string> = {
  money: "--nw-money", property: "--nw-property", vehicle: "--nw-vehicle",
  mortgage: "--nw-mortgage", loan: "--nw-loan",
};
