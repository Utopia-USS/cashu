import type { Meta, Story } from "../charts/testing/csf.js";
import { Kpi, type KpiProps } from "./Kpi.js";

const meta = {
  title: "Surfaces/Kpi",
  component: Kpi,
  args: { label: "Pozostało", value: "312 400,00 zł", tone: "negative", hint: "14 rat spłaconych" },
} satisfies Meta<KpiProps>;
export default meta;
export const Default: Story<KpiProps> = {};
export const Plain: Story<KpiProps> = { args: { tone: undefined, hint: undefined } };
