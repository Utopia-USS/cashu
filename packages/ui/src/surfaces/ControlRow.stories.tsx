import type { Meta, Story } from "../charts/testing/csf.js";
import { ControlRow } from "./ChartCard.js";

type Props = Parameters<typeof ControlRow>[0];
const meta = {
  title: "Surfaces/ControlRow",
  component: ControlRow,
  args: { children: "Controls" },
} satisfies Meta<Props>;
export default meta;
export const Default: Story<Props> = {};
