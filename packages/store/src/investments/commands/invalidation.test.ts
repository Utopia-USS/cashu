// Touched-table invalidation (testing.md: "a test that each command's touched tables re-run the
// queries that read them"): for every S22d command, the tables its batch touched intersect the read
// set of the queries a screen would show for it (recorded from the SQL the query ran), a subscriber
// to that read set is notified, and the query's answer changed. Synthetic data only.
import { describe, expect, it } from "vitest";
import { type Command, runCommand } from "../../command.js";
import * as q from "../queries/index.js";
import type { Read } from "../queries/shared.js";
import {
  addInstrumentAliases,
  applySignalActions,
  classifyInstrument,
  createInstrument,
  createThesis,
  deleteThesis,
  mergeInstruments,
  recordDecision,
  setInstrumentPlan,
  setInstrumentSegment,
  setInstrumentStatus,
  setManualValuation,
  snoozeSignalCommand,
  undoDecision,
  updateThesis,
  wakeSnoozedSignals,
} from "./index.js";
import { applyRaw, raw, rawGid, stock, type Vault, vault } from "./testing/fixtures.js";

/** Run `cmd` and check `query` re-runs: its read tables were touched, it was notified, it changed. */
function expectInvalidates<I, R>(
  v: Vault,
  cmd: Command<I, R>,
  input: unknown,
  query: (read: Read) => unknown,
) {
  const sqls: string[] = [];
  const recording: Read = (sql, ...params) => {
    sqls.push(sql);
    return v.store.read(sql, ...params);
  };
  const plain: Read = (sql, ...params) => v.store.read(sql, ...params);
  const before = JSON.stringify(query(recording), (_k, x: unknown) =>
    x instanceof Set ? [...x] : x,
  );
  const reads = new Set(sqls.flatMap((s) => [...v.store.tablesRead(s)]));
  let notified = 0;
  let touched: ReadonlySet<string> = new Set();
  const off = v.store.subscribe(reads, () => {
    notified += 1;
  });
  const out = runCommand(
    v.store,
    {
      append: (batch) => {
        touched = v.store.applyEnvelopes(batch).touchedTables;
      },
    },
    cmd,
    input,
    v.env,
  );
  off();
  expect(out.ok, cmd.id).toBe(true);
  expect(
    [...touched].some((t) => reads.has(t)),
    `${cmd.id} touched ${[...touched]}`,
  ).toBe(true);
  expect(notified, cmd.id).toBe(1);
  expect(
    JSON.stringify(query(plain), (_k, x: unknown) => (x instanceof Set ? [...x] : x)),
    cmd.id,
  ).not.toBe(before);
  return out;
}

describe("S22d command batches invalidate the queries that read their tables", () => {
  it("instrument commands", () => {
    const v = vault();
    expectInvalidates(
      v,
      createInstrument,
      { name: "A SA", currency: "PLN", assetClass: "equity", isin: "PL0000000AAA" },
      (r) => q.allInstruments(r),
    );
    const a = stock(v, "AAA", "PL0000000AAA");
    const b = v.value(createInstrument, {
      name: "B SA",
      currency: "PLN",
      assetClass: "equity",
      aliases: [{ namespace: "xtb", value: "BBB.PL" }],
    }).gid;
    expectInvalidates(v, classifyInstrument, { instrument: a, tags: ["x"] }, (r) =>
      q.loadInstrument(r, a),
    );
    expectInvalidates(v, setInstrumentPlan, { instrument: a, plan: "buy", held: false }, (r) =>
      q.loadInstrument(r, a),
    );
    expectInvalidates(
      v,
      setInstrumentSegment,
      { instrument: a, segment: "software", by: "owner" },
      (r) => q.loadInstrument(r, a),
    );
    expectInvalidates(v, setInstrumentStatus, { instrument: a, status: "frozen" }, (r) =>
      q.loadInstrument(r, a),
    );
    expectInvalidates(
      v,
      setManualValuation,
      { instrument: a, asOf: "2026-01-01", unitValue: "1", currency: "PLN" },
      (r) => q.manualValuations(r),
    );
    expectInvalidates(
      v,
      addInstrumentAliases,
      { instrument: a, aliases: [{ namespace: "yahoo", value: "AAA.WA" }] },
      (r) => q.instrumentByAlias(r, "yahoo", "AAA.WA"),
    );
    expectInvalidates(v, createThesis, { instrument: b, entryType: "trend", thesis: "x" }, (r) =>
      q.theses(r, b),
    );
    expectInvalidates(v, mergeInstruments, { source: b, target: a }, (r) => q.theses(r, a));
  });

  it("journal and signal commands", () => {
    const v = vault();
    const a = stock(v, "AAA", "PL0000000AAA");
    const run = rawGid(1);
    applyRaw(v, [raw.ruleRun(run), raw.signalOpened(rawGid(2), `r|i:${a}`, { instrument: a })]);
    const opened = expectInvalidates(
      v,
      applySignalActions,
      {
        run,
        actions: [
          {
            type: "create",
            candidate: {
              ruleId: "s",
              kind: "k",
              dedupKey: `s|i:${a}`,
              severity: "info",
              message: "m",
            },
            createdAt: "2026-10-31T06:00:00.000Z",
          },
        ],
      },
      (r) => q.openSignals(r),
    );
    const signal = opened.ok ? (opened.value.created[0] ?? "") : "";
    const d = expectInvalidates(v, recordDecision, { action: "held", signals: [signal] }, (r) =>
      q.openSignals(r),
    );
    expectInvalidates(v, undoDecision, { decision: d.ok ? d.value.decision : "" }, (r) =>
      q.decisions(r),
    );
    expectInvalidates(v, snoozeSignalCommand, { signal, until: "2026-10-31T12:00:01.000Z" }, (r) =>
      q.signalByGid(r, signal),
    );
    v.env.advance(2000);
    expectInvalidates(v, wakeSnoozedSignals, {}, (r) => q.openSignals(r));
    const t = v.value(createThesis, { instrument: a, entryType: "trend", thesis: "x" }).thesis;
    expectInvalidates(v, updateThesis, { id: t, values: { thesis: "y" } }, (r) => q.theses(r));
    expectInvalidates(v, deleteThesis, { id: t }, (r) => q.theses(r));
  });
});
