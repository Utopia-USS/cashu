import type { Meta, Story } from "../charts/testing/csf.js";
import { PlanGlyph, type PlanGlyphProps } from "./InstTile.js";

const meta = {
  title: "Instruments/PlanGlyph",
  component: PlanGlyph,
  args: { path: "M3.5 7.5 6 5l2.5 2.5" },
} satisfies Meta<PlanGlyphProps>;
export default meta;
export const Coin: Story<PlanGlyphProps> = {};
export const Empty: Story<PlanGlyphProps> = { args: { path: null } };
