// @cashu/ui/native: the part of the display layer the phone renders (apps/mobile imports this, not the
// root). The root `@cashu/ui` also re-exports the desktop-only components (research, instruments,
// overlays, DOM virtual lists with @tanstack/react-virtual); Metro (the phone) does not tree-shake, so
// importing the root there bundles all of them. Add a component here when the phone starts to render
// it, and add its files as `@source` lines of tokens/native.css (the arch guard nativeStyles.test.ts
// names them), or Uniwind generates no styles for it.
export { BarChart } from "./charts/BarChart.js";
export { Donut } from "./charts/Donut.js";
export { LineChart } from "./charts/LineChart.js";
export { Sparkline } from "./charts/Sparkline.js";
export type {
  BarChartProps,
  ChartTip,
  DonutProps,
  DonutSegment,
  LineChartProps,
  SparklineProps,
} from "./charts/types.js";
export { Button } from "./controls/Button.js";
export type { ButtonProps } from "./controls/Button.types.js";
export {
  CategoryGrid,
  type CategoryGridProps,
  type CategoryOption,
} from "./controls/CategoryGrid.js";
export { applyKeypadKey, Keypad, type KeypadKey, type KeypadProps } from "./controls/Keypad.js";
export { SearchField, type SearchFieldProps } from "./controls/SearchField.js";
export { Seg } from "./controls/Seg.js";
export type { SegProps } from "./controls/Seg.types.js";
export { ToggleRow, type ToggleRowProps } from "./controls/ToggleRow.js";
export { type UiEnv, UiEnvProvider, useUiEnv } from "./environment/UiEnv.js";
export { Banner, type BannerProps } from "./feedback/Banner.js";
export { EmptyState, type EmptyStateProps } from "./feedback/EmptyState.js";
export { NoteLine, type NoteLineProps } from "./feedback/NoteLine.js";
export { ProgressDots, type ProgressDotsProps } from "./feedback/ProgressDots.js";
export { Icon, type IconName, type IconProps } from "./icons/Icon.js";
export { DateLead, type DateLeadProps, ListRow, type ListRowProps } from "./lists/ListRow.js";
export { Swatch, type SwatchColor } from "./lists/Swatch.js";
export { type SwipeDirection, SwipeStack, type SwipeStackProps } from "./lists/SwipeStack.js";
export { Meter, type MeterProps, PaceMeter, type PaceMeterProps } from "./meters/Meter.js";
export { FreshLine, type FreshLineProps } from "./status/FreshLine.js";
export { Card } from "./surfaces/Card.js";
export type { CardProps } from "./surfaces/Card.types.js";
export { Facts, type FactsItem, type FactsProps } from "./surfaces/Facts.js";
export { KpiStrip, type KpiStripItem, type KpiStripProps } from "./surfaces/KpiStrip.js";
export { Tag } from "./surfaces/Tag.js";
export type { TagProps, TagTone } from "./surfaces/Tag.types.js";
export { Tile, type TileProps } from "./surfaces/Tile.js";
export { Amount } from "./values/Amount.js";
export { DateText } from "./values/DateText.js";
export { Delta } from "./values/Delta.js";
export { Figure, type FigureProps } from "./values/Figure.js";
export { Money } from "./values/Money.js";
export { Percent } from "./values/Percent.js";
export type {
  AmountProps,
  DateTextProps,
  DeltaProps,
  MoneyProps,
  PercentProps,
} from "./values/types.js";
