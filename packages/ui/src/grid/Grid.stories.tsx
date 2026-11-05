import type { Meta, Story } from "../charts/testing/csf.js";
import { Grid, type GridProps } from "./Grid.js";

const meta = {
  title: "Layout/Grid",
  component: Grid,
  args: {
    items: [
      { id: "hero", span: 3, node: "Hero" },
      { id: "value", span: 2, node: "Value" },
      { id: "alerts", span: 1, node: "Alerts" },
    ],
  },
} satisfies Meta<GridProps>;
export default meta;
export const Default: Story<GridProps> = {};
