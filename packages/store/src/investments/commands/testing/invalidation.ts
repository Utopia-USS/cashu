// Touched-table invalidation (testing.md): run a command and check that a query re-runs: its read
// tables were touched by the batch, a subscriber to that read set was notified once, and the query's
// answer changed. Test helper shared by the investments command invalidation tests.
import { expect } from "vitest";
import { type Command, runCommand } from "../../../command.js";
import type { Read } from "../../queries/shared.js";
import type { Vault } from "./fixtures.js";

export /** Run `cmd` and check `query` re-runs: its read tables were touched, it was notified, it changed. */
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
  const before = JSON.stringify(query(recording), setsAsLists);
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
  expect(JSON.stringify(query(plain), setsAsLists), cmd.id).not.toBe(before);
  return out;
}

/** JSON replacer: Sets and Maps compare by their entries. */
function setsAsLists(_key: string, value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return [...value];
  return value;
}
