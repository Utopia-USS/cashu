import type { Meta, Story } from "../charts/testing/csf.js";
import { InstLabel, type InstLabelProps } from "./InstTile.js";

const meta = {
  title: "Instruments/InstLabel",
  component: InstLabel,
  args: {
    monogram: "GLBA",
    density: "compact",
    name: "Demo Global Equity",
    sub: "60.9 % of the portfolio",
  },
} satisfies Meta<InstLabelProps>;
export default meta;
export const Compact: Story<InstLabelProps> = {};
export const Openable: Story<InstLabelProps> = { args: { density: "row", onOpen: () => {} } };
