// Touched-table invalidation (testing.md: "a test that each command's touched tables re-run the
// queries that read them"): for every research command, the tables its batch touched intersect the
// read set of the query a screen shows for it (recorded from the SQL the query ran), a subscriber to
// that read set is notified once, and the query's answer changed. Synthetic data only.
import { describe, expect, it } from "vitest";
import { type Command, runCommand } from "../../command.js";
import { stock, type Vault } from "../commands/testing/fixtures.js";
import type { Read } from "../queries/shared.js";
import { acceptCandidate, undoAcceptCandidate } from "./candidates.js";
import {
  addResearchNote,
  dismissResearchNote,
  finishResearchRun,
  markResearchRead,
  researchHousekeeping,
  restoreResearchNote,
  startResearchRun,
} from "./commands.js";
import {
  noteByGid,
  notes,
  openResearchSignals,
  runs,
  topicThesisRow,
  unreadNotes,
} from "./queries.js";
import { eventInstant } from "./rows.js";
import { added, DAY, investor } from "./testing/fixtures.js";
import {
  deleteTopicThesis,
  proposeTopicDraft,
  saveTopicThesis,
  setTopicMarketView,
} from "./topics.js";

const json = (x: unknown) =>
  JSON.stringify(x, (_k, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value instanceof Set ? [...value] : value,
  );

const nowOf = (v: Vault) => eventInstant(new Date(v.env.clock.now()).toISOString());

/** Run `cmd` and check `query` re-runs: its read tables were touched, it was notified, it changed. */
function expectInvalidates<I, R>(
  v: Vault,
  cmd: Command<I, R>,
  input: unknown,
  query: (read: Read) => unknown,
): R {
  const sqls: string[] = [];
  const recording: Read = (sql, ...params) => {
    sqls.push(sql);
    return v.store.read(sql, ...params);
  };
  const plain: Read = (sql, ...params) => v.store.read(sql, ...params);
  const before = json(query(recording));
  const reads = new Set(sqls.flatMap((s) => [...v.store.tablesRead(s)]));
  let notified = 0;
  let touched: ReadonlySet<string> = new Set();
  const off = v.store.subscribe(reads, () => {
    notified += 1;
  });
  const out = runCommand(
    v.store,
    { append: (batch) => (touched = v.store.applyEnvelopes(batch).touchedTables) },
    cmd,
    input,
    v.env,
  );
  off();
  if (!out.ok) expect.fail(`${cmd.id} refused: ${out.reason}`);
  expect(
    [...touched].some((t) => reads.has(t)),
    `${cmd.id} touched ${[...touched]}`,
  ).toBe(true);
  expect(notified, cmd.id).toBe(1);
  expect(json(query(plain)), cmd.id).not.toBe(before);
  return out.value;
}

const SOURCE = [
  { url: "https://example.com/inv/1", publisher: "Example", published_at: "2026-10-31" },
];

describe("research command batches invalidate the queries that read their tables", () => {
  it("runs and notes", () => {
    const { v } = investor();
    const { run } = expectInvalidates(v, startResearchRun, {}, (read) => runs(read));
    const note = expectInvalidates(
      v,
      addResearchNote,
      {
        note: {
          kind: "news",
          polarity: "negative",
          strength: 3,
          title: "Example fact for invalidation",
          summary: "Przykladowy fakt do testu odswiezania.",
          sources: SOURCE,
        },
        instrument: "XMPL",
      },
      (read) => notes(read, nowOf(v)),
    ).note;
    expectInvalidates(v, markResearchRead, { ids: [note] }, (read) => unreadNotes(read, nowOf(v)));
    expectInvalidates(v, dismissResearchNote, { note }, (read) => noteByGid(read, note));
    expectInvalidates(v, restoreResearchNote, { note }, (read) => noteByGid(read, note));
    expectInvalidates(v, finishResearchRun, { run }, (read) => runs(read));
  });

  it("candidates", () => {
    const { v } = investor();
    const note = added(
      v,
      1,
      {
        kind: "candidate",
        polarity: "positive",
        candidate: { symbol_or_isin: "NEWCO.WA", name: "Newco SA" },
        details: { entry_type: "trend", criteria: [{ text: "C/Z 9", met: true }] },
      },
      { instrument: null },
    ).note;
    const newco = stock(v, "NEWCO", "PLNEWCO00019");
    expectInvalidates(v, acceptCandidate, { note, instrument: newco }, (read) =>
      noteByGid(read, note),
    );
    expectInvalidates(v, undoAcceptCandidate, { note }, (read) => noteByGid(read, note));
  });

  it("housekeeping", () => {
    const { v } = investor();
    added(v, 1, { strength: 3, expires_in_days: 1 });
    v.env.advance(2 * DAY);
    expectInvalidates(v, researchHousekeeping, {}, (read) => openResearchSignals(read));
  });

  it("topic theses", () => {
    const { v } = investor();
    const row = (read: Read) => topicThesisRow(read, "robotics");
    expectInvalidates(v, proposeTopicDraft, { segment: "robotics", thesis: "Szkic." }, row);
    expectInvalidates(v, saveTopicThesis, { segment: "robotics", thesis: "Teza." }, row);
    expectInvalidates(
      v,
      setTopicMarketView,
      {
        segment: "robotics",
        by: "owner",
        assessment: "Adopcja robotów przyspiesza, ale wyceny są wysokie.",
      },
      row,
    );
    expectInvalidates(v, deleteTopicThesis, { segment: "robotics" }, row);
  });
});
