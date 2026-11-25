// Stories of the UI environment provider: the same chart with privacy mode off and on (synthetic data).

import type { ReactNode } from "react";
import { LineChart } from "../charts/LineChart.js";
import type { Meta, Story } from "../charts/testing/csf.js";
import { monthLabels, rising, thousands } from "../charts/testing/data.js";
import { type UiEnv, UiEnvProvider } from "./UiEnv.js";

type Props = UiEnv & { children: ReactNode };

const chart = (
  <LineChart
    label="Net worth"
    width={480}
    series={[{ values: rising(12, 100_000, 3_000), area: true }]}
    xLabels={monthLabels(12, [0, 11])}
    yFormat={thousands}
  />
);

const meta = {
  title: "Environment/UiEnvProvider",
  component: UiEnvProvider,
  args: { privacy: false, children: chart },
} satisfies Meta<Props>;
export default meta;

export const AmountsShown: Story<Props> = {};

export const PrivacyOn: Story<Props> = { args: { privacy: true } };
