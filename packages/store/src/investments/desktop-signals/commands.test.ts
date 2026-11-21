import { describe, expect, it } from "vitest";
import { type Command, runCommand, setModules, storeWriter } from "../../index.js";
import { createAlertWithBuckets } from "../commands/alertWrites.js";
import { vault } from "../commands/testing/fixtures.js";
import type { CurrentStrategySource } from "../desktop/sources.js";
import { signalsAlertCommands } from "./commands.js";

const NOW = "2026-11-03T12:00:00.000Z";
function setup() {
  const v = vault();
  v.value(setModules, { moduleIds: ["investments"] });
  const run = <I, R>(command: Command<I, R>, input: unknown) =>
    runCommand(
      v.store,
      storeWriter(v.store),
      {
        ...command,
        run(ctx, parsed) {
          return command.run({ ...ctx, now: () => NOW }, parsed);
        },
      },
      input,
      v.env,
    );
  return { run };
}
const bucket = {
  kind: "weight_above",
  instrument: null,
  scope: "bucket",
  title: "Synthetic bucket",
  params: { bucket: "core", threshold: 0.2 },
};
const source = (ids: readonly string[] | null): CurrentStrategySource => ({
  changes: { subscribe: () => () => {} },
  current: () =>
    ids === null
      ? { status: "unavailable", reason: "synthetic_unavailable" }
      : {
          status: "current",
          vault: "synthetic",
          generation: "one",
          revision: "one",
          state: { config: { allocation: { buckets: ids.map((id) => ({ id })) } } } as never,
        },
});

describe("Signals owner alert authority", () => {
  it("rechecks bucket edits against current file authority", () => {
    const { run } = setup();
    const created = run(createAlertWithBuckets(new Set(["core"])), bucket);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const changes = {
      alert: created.value.alert,
      changes: { params: { bucket: "other", threshold: 0.2 } },
    };
    expect(run(signalsAlertCommands(source(null)).update, changes)).toEqual({
      ok: false,
      reason: "current_files_unavailable",
    });
    expect(run(signalsAlertCommands(source([])).update, changes)).toEqual({
      ok: false,
      reason: "unknown_bucket",
    });
  });
});
