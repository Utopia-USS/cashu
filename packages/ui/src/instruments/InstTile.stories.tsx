import type { Meta, Story } from "../charts/testing/csf.js";
import { InstTile, type InstTileProps } from "./InstTile.js";

const buy = "M3.5 7.5 6 5l2.5 2.5";
const meta = {
  title: "Instruments/InstTile",
  component: InstTile,
  args: { monogram: "DMEN", density: "compact" },
} satisfies Meta<InstTileProps>;
export default meta;
export const Compact: Story<InstTileProps> = {};
export const RowWithPlan: Story<InstTileProps> = {
  args: { density: "row", monogram: "GLBA", plan: buy, health: "sup" },
};
export const Dense: Story<InstTileProps> = { args: { monogram: "BRK-B" } };
export const Quiet: Story<InstTileProps> = { args: { monogram: "Σ", quiet: true } };
export const Mark: Story<InstTileProps> = {
  args: { monogram: "", density: "mark", health: "weak" },
};
