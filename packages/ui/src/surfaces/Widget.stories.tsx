import type { Meta, Story } from "../charts/testing/csf.js";
import { Widget, type WidgetProps } from "./Widget.js";

const meta = {
  title: "Surfaces/Widget",
  component: Widget,
  args: { title: "Signals", children: "Seven new items since the review." },
} satisfies Meta<WidgetProps>;
export default meta;
export const Default: Story<WidgetProps> = {};
export const WithFooter: Story<WidgetProps> = {
  args: { count: 7, tight: true, footer: "12 months TWR" },
};
export const Highlight: Story<WidgetProps> = { args: { highlight: true } };
export const Ghost: Story<WidgetProps> = { args: { ghost: true } };
