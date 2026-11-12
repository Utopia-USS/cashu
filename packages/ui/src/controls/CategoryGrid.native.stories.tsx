import type { Meta, Story } from "../charts/testing/csf.js";
import { CategoryGrid, type CategoryGridProps } from "./CategoryGrid.js";

const options: CategoryGridProps["options"] = [
  { key: "groceries", label: "Groceries", swatch: "palette-2" },
  { key: "eating-out", label: "Eating out", swatch: "palette-5" },
  { key: "transport", label: "Transport", swatch: "palette-1" },
  { key: "home", label: "Home", swatch: "palette-6" },
  { key: "health", label: "Health", swatch: "palette-3" },
  { key: "fun", label: "Fun", swatch: "palette-4" },
  { key: "clothes", label: "Clothes", swatch: "palette-8" },
  { key: "bills", label: "Bills", swatch: "palette-7" },
];

const meta = {
  title: "Native/CategoryGrid",
  component: CategoryGrid,
  args: {
    options,
    selected: null,
    suggested: null,
    suggestedHint: "Suggested",
    expanded: false,
    onPick: () => {},
    onExpand: () => {},
    expandLabel: "All categories",
  },
} satisfies Meta<CategoryGridProps>;
export default meta;
export const Collapsed: Story<CategoryGridProps> = {};
export const Selected: Story<CategoryGridProps> = { args: { selected: "groceries" } };
export const Suggested: Story<CategoryGridProps> = { args: { suggested: "eating-out" } };
export const SelectedAndSuggested: Story<CategoryGridProps> = {
  args: { selected: "transport", suggested: "eating-out" },
};
export const Expanded: Story<CategoryGridProps> = { args: { expanded: true, selected: "bills" } };
export const FewOptions: Story<CategoryGridProps> = { args: { options: options.slice(0, 3) } };
