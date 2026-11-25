import type { Meta, Story } from "../charts/testing/csf.js";
import { SumStrip } from "./SumStrip.js";

type Props = Parameters<typeof SumStrip>[0];
const meta = {
  title: "Surfaces/SumStrip",
  component: SumStrip,
  args: { items: [{ key: "total", label: "Total expenses", value: "139.00" }] },
} satisfies Meta<Props>;
export default meta;
export const Default: Story<Props> = {};
