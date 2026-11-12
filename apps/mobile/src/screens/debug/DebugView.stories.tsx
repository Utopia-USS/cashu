// Stories of the debug screen (CSF 3, synthetic state): first launch, reopened, failures. The RNTL
// smoke test renders every story; on-device Storybook picks the same file up once it is wired.
import { DebugView, type DebugViewProps } from "./DebugView";

const base: DebugViewProps = {
  vault: "ca000000000000000000000000000a11",
  openMs: "12",
  load: { firstLaunch: true, events: 1312, applyMs: "730", rebuild: null },
  tables: [
    { table: "accounts", rows: 4 },
    { table: "transactions", rows: 2340 },
    { table: "category_rules", rows: 24 },
  ],
  cursors: 0,
  needsUpgrade: false,
  unfoldedTypes: 0,
  balanceTrend: [
    61200, 63100, 62950, 64800, 66010, 65400, 67900, 69300, 68800, 71200, 72950, 74100,
  ],
  balanceMonths: [
    { i: 0, text: "2025-11" },
    { i: 5, text: "2026-04" },
    { i: 11, text: "2026-10" },
  ],
  balanceAxis: (v) => `${Math.round(v / 1000)}k`,
  balanceTip: (i) => ({
    title: `month ${i + 1}`,
    rows: [{ name: "Balance", value: "70 000 zł", amount: true }],
  }),
  spendingByAccount: [
    { name: "Konto osobiste (demo)", value: 48210, color: 1 },
    { name: "Konto wspolne (demo)", value: 54930, color: 2 },
  ],
  cryptoPanel: null,
  rebuilding: false,
  onRebuild: () => {},
  onOpenBench: () => {},
};

const meta = { title: "Mobile/Debug", component: DebugView, args: base };
export default meta;

export const FirstLaunch = { args: base };
export const Reopened = { args: { ...base, load: null } };
export const Failures = {
  args: {
    ...base,
    load: {
      firstLaunch: false,
      events: 1312,
      applyMs: null,
      rebuild: {
        ms: "980",
        matches: false,
        viewHash: "9855108c69c7dca78612ef4b784dc3f884a868d138790f7df9569d92529c5d9d",
      },
    },
    needsUpgrade: true,
  },
};
