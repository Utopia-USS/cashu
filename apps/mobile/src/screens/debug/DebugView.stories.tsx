// Stories of the debug screen (CSF 3, synthetic state): first launch, reopened, failures. The RNTL
// smoke test renders every story; on-device Storybook picks the same file up once it is wired.
import { DebugView, type DebugViewProps } from "./DebugView";

const base: DebugViewProps = {
  vault: "de000000000000000000000000000041",
  openMs: "12",
  load: {
    firstLaunch: true,
    events: 2648,
    applyMs: "1450",
    rebuildMs: "980",
    rebuildMatches: true,
    viewHash: "9855108c69c7dca78612ef4b784dc3f884a868d138790f7df9569d92529c5d9d",
  },
  tables: [
    { table: "accounts", rows: 4 },
    { table: "transactions", rows: 2340 },
    { table: "category_rules", rows: 24 },
  ],
  cursors: 0,
  needsUpgrade: false,
  unfoldedTypes: 0,
  crypto: {
    ok: true,
    checks: [
      { name: "knownAnswer", ok: true },
      { name: "frame", ok: true },
      { name: "keyStore", ok: true },
    ],
    nativeAead: "unsupported_runtime",
  },
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
    load: { ...(base.load as NonNullable<DebugViewProps["load"]>), rebuildMatches: false },
    needsUpgrade: true,
    crypto: {
      ok: false,
      checks: [{ name: "knownAnswer", ok: false, code: "unsupported_runtime" }],
      nativeAead: "not_run",
    },
  },
};
