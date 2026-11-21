import { SpendingDonut, type SpendingDonutProps } from "./SpendingDonut.js";
import type { Meta, Story } from "./testing/csf.js";

const meta = {
  title: "Charts/SpendingDonut",
  component: SpendingDonut,
  args: {
    label: "Expenses",
    slices: [
      {
        key: "food",
        label: "Groceries",
        value: 3,
        amount: "300.00",
        share: "60%",
        color: "palette-1",
      },
      { key: "fun", label: "Fun", value: 2, amount: "200.00", share: "40%", color: "palette-2" },
    ],
    onSelect: () => {},
    total: { label: "Total expenses", value: "500.00" },
  },
} satisfies Meta<SpendingDonutProps>;
export default meta;
export const Default: Story<SpendingDonutProps> = {};
