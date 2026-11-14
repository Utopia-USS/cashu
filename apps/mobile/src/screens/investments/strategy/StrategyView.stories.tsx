// Pure presentation variants of the Investments tab's Strategy view, all invented. Store-backed
// integration lives in investments.native.test.tsx.
import type { StrategyViewProps } from "../investments-contracts";
import { StrategyView } from "./StrategyView";

const ready: StrategyViewProps = {
  document: {
    updated: "2026-10-02",
    blocks: [
      { t: "h", level: 1, c: ["Long-term, boring on purpose"] },
      { t: "h", level: 3, c: ["Goal"] },
      {
        t: "p",
        c: ["Independence from a salary by 2045. I can sit through a 30% fall without selling."],
      },
      { t: "h", level: 3, c: ["Drawdowns"] },
      {
        t: "quote",
        blocks: [
          {
            t: "p",
            c: ["A drawdown alone is not a reason to sell. Check the thesis, then decide."],
          },
        ],
      },
    ],
  },
  rules: [
    {
      id: "rebalance_check",
      name: "Buckets within their bands",
      kind: "allocation drift",
      tag: { label: "fired", tone: "warning" },
    },
    {
      id: "single_stock_limit",
      name: "One position at most 10%",
      kind: "concentration",
      tag: { label: "ok", tone: "positive" },
    },
  ],
  alertsCount: 6,
};

const meta = { title: "Mobile/Investments/Strategy", component: StrategyView, args: ready };
export default meta;

export const Ready = { args: ready };
export const NoStrategy = {
  args: { document: null, rules: [], alertsCount: 0 } satisfies StrategyViewProps,
};
export const NoRules = {
  args: { ...ready, rules: [], alertsCount: 0 } satisfies StrategyViewProps,
};
