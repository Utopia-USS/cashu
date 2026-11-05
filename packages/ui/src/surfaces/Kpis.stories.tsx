import type { Meta, Story } from "../charts/testing/csf.js";
import { Kpi, Kpis, type KpisProps } from "./Kpi.js";

const meta = {
  title: "Surfaces/Kpis",
  component: Kpis,
  args: {
    children: [
      <Kpi key="a" label="Rata miesięczna" value="2 530,00 zł" />,
      <Kpi key="b" label="Pozostało" value="312 400,00 zł" tone="negative" />,
    ],
  },
} satisfies Meta<KpisProps>;
export default meta;
export const Default: Story<KpisProps> = {};
