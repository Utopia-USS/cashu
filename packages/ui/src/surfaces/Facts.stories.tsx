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
