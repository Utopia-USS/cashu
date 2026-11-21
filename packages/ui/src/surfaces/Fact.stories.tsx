import type { Meta, Story } from "../charts/testing/csf.js";
import { Fact, type FactProps } from "./Fact.js";

const meta = {
  title: "Surfaces/Fact",
  component: Fact,
  args: { label: "Drawdown", value: "-3.9 %", detail: "max -9.6 %" },
} satisfies Meta<FactProps>;
export default meta;
export const Default: Story<FactProps> = {};
export const Negative: Story<FactProps> = { args: { tone: "negative", size: "sm" } };
export const Tile: Story<FactProps> = {
  args: { label: "Liquid", value: "46,812 PLN", detail: "4.1 mo. of spending", tile: true },
};
