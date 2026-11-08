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
export { type UiEnv, UiEnvProvider, useUiEnv } from "./environment/UiEnv.js";
export { DateText } from "./values/DateText.js";
export { Money } from "./values/Money.js";
export type { DateTextProps, MoneyProps } from "./values/types.js";
