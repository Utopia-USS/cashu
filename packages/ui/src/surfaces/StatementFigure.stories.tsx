import type { Meta, Story } from "../charts/testing/csf.js";
import { StatementFigure, type StatementFigureProps } from "./StatementFigure.js";

const meta = {
  title: "Surfaces/StatementFigure",
  component: StatementFigure,
  args: { value: "559 702,01 zł" },
} satisfies Meta<StatementFigureProps>;
export default meta;
export const Page: Story<StatementFigureProps> = {};
export const Tile: Story<StatementFigureProps> = {
  args: { value: "PLN 559,702.01", size: "tile" },
};
export const Privacy: Story<StatementFigureProps> = { args: { value: "••• zł", size: "tile" } };
