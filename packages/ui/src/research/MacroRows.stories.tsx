import type { Meta, Story } from "../charts/testing/csf.js";
import { MacroRows } from "./MacroRows.js";

type Props = Parameters<typeof MacroRows>[0];
const meta = {
  title: "Research/MacroRows",
  component: MacroRows,
  args: {
    label: "Macro",
    rows: [
      {
        id: "risk",
        label: "Risk appetite",
        onOpen: () => {},
        states: [{ text: "risk on", tone: "positive" }],
        since: "since Oct 2026",
        headline: "Markets are calm.",
        why: "Volatility is low.",
        supports: { label: "Supports", items: ["equities"] },
        risks: { label: "Watch", items: ["a sudden sell-off"] },
        explain: {
          head: "Risk on since Oct",
          text: "Synthetic explanation.",
          metrics: [{ label: "VIX", text: "14" }],
        },
      },
      {
        id: "rates",
        label: "Rates",
        onOpen: () => {},
        missing: "no data",
        states: [],
        headline: "No data yet.",
      },
    ],
  },
} satisfies Meta<Props>;
export default meta;
export const Default: Story<Props> = {};
