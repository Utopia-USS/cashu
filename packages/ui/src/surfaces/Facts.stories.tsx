import type { Meta, Story } from "../charts/testing/csf.js";
import { Facts, type FactsProps } from "./Fact.js";

const meta = {
  title: "Surfaces/Facts",
  component: Facts,
  args: {
    items: [
      { label: "Value", value: "60 841" },
      { label: "Deposits", value: "25 000", detail: "plan 27 500" },
    ],
  },
} satisfies Meta<FactsProps>;
export default meta;
export const Default: Story<FactsProps> = {};
export const Tiles: Story<FactsProps> = {
  args: {
    columns: 4,
    tile: true,
    items: [
      { label: "Assets", value: "990,902 PLN", detail: "4 accounts · 3 modules" },
      { label: "Liabilities", value: "-431,200 PLN", detail: "mortgage, loan" },
      { label: "Home equity", value: "407,700 PLN", detail: "property - mortgage" },
      { label: "Liquid", value: "46,812 PLN", detail: "4.1 mo. of spending" },
    ],
  },
};
