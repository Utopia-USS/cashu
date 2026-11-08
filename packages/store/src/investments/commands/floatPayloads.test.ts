// Floats in free JSON blobs (events.md 4.3): event data carries them as decimal text with their paths
// in `<blob>Floats` (integer-only, as the native batch proof requires); the folds put the JSON numbers
// back, so views and readers see exactly what the writer had.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCommand, ok } from "../../command.js";
import { createProposal } from "../../core/proposal-commands.js";
import type { Envelope } from "../../events/v1/envelope.js";
import { alertByGid } from "../queries/alerts.js";
import { signalByGid } from "../queries/signals.js";
import { createAlert, updateAlert } from "./alertWrites.js";
import { applySignalActions } from "./signals.js";
import { applyRaw, raw, rawGid, stock, vault } from "./testing/fixtures.js";

const NOW = "2026-10-31T12:00:00.000Z";
function events(outcome: { ok: boolean; events?: readonly Envelope[] }): readonly Envelope[] {
  if (!outcome.ok || outcome.events === undefined) throw new Error("command refused");
  return outcome.events;
}

describe("floats in event blobs", () => {
  it("refuses an emit with a raw float in a memory store as a native vault would", () => {
    const v = vault();
    const raw = defineCommand({
      id: "test.rawFloat",
      input: z.object({}),
      run(ctx) {
        ctx.emit("proposal.created", ctx.newGid(), {
          kind: "custom_rule",
          summary: "Synthetic",
          reason: null,
          source: "agent",
          payload: { rule: { params: { max_weight: 0.5 } } },
        });
        return ok(null);
      },
    });
    expect(() => v.run(raw, {})).toThrow(
      "carries a non-integer number at data.payload.rule.params.max_weight",
    );
  });

  it("stores an agent's custom-rule parameter 0.5 and shows the proposal with the number", () => {
    const v = vault();
    const rule = { id: "agent_cash_half", kind: "cash_level", params: { max_weight: 0.5 } };
    const outcome = v.run(createProposal, {
      kind: "custom_rule",
      summary: "Rule agent_cash_half (cash_level): fired 0x in backtest",
      summaryParams: { episodes: 0 },
      reason: null,
      payload: { rule, rule_yaml: "- id: agent_cash_half\n", base_sha256: "0".repeat(64) },
      source: "agent",
    });
    const [created] = events(outcome);
    expect(created?.data).toMatchObject({
      payload: { rule: { params: { max_weight: "0.5" } } },
      payloadFloats: [["rule", "params", "max_weight"]],
    });
    const [row] = v.store.read<{ payload: string }>("SELECT payload FROM proposals");
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      rule,
      summary_params: { episodes: 0 },
    });
  });

  it("keeps alert defaults and edited thresholds as numbers in the view", () => {
    const v = vault();
    const instrument = stock(v, "AAA", "PL0000000AAA");
    applyRaw(v, [raw.watchAdded(v, instrument)]);
    const created = v.run(createAlert, {
      kind: "range_breakout",
      instrument,
      title: "Synthetic breakout",
      params: {},
    });
    const [event] = events(created);
    expect(event?.data).toMatchObject({
      params: { window_days: 30, max_range_pct: "0.08" },
      paramsFloats: [["max_range_pct"]],
    });
    if (!created.ok) throw new Error(created.reason);
    const alert = created.value.alert;
    const read = v.store.read.bind(v.store);
    expect(alertByGid(read, alert, NOW)?.params).toMatchObject({
      window_days: 30,
      max_range_pct: 0.08,
    });
    const updated = v.run(updateAlert, {
      alert,
      changes: { params: { window_days: 25, max_range_pct: 0.125 } },
    });
    expect(events(updated)[0]?.data).toMatchObject({ paramsFloats: [["max_range_pct"]] });
    expect(alertByGid(read, alert, NOW)?.params).toEqual({
      window_days: 25,
      max_range_pct: 0.125,
      direction: "any",
    });
  });

  it("opens and refreshes a signal whose payload holds floats; the view keeps the numbers", () => {
    const v = vault();
    const i = stock(v, "AAA", "PL0000000AAA");
    const run = rawGid(1);
    applyRaw(v, [raw.ruleRun(run)]);
    const candidate = (weight: number) => ({
      ruleId: "concentration",
      kind: "position_concentration",
      dedupKey: `concentration|i:${i}`,
      severity: "info",
      message: "Synthetic concentration",
      instrument: i,
      payload: { weight, max_weight: 0.15, values: [0.5, 2], accounts: 1, level: "101.50" },
    });
    const opened = v.run(applySignalActions, {
      run,
      actions: [{ type: "create", candidate: candidate(0.18), createdAt: NOW }],
    });
    expect(events(opened)[0]?.data).toMatchObject({
      payload: { weight: "0.18", max_weight: "0.15", values: ["0.5", 2], level: "101.50" },
      payloadFloats: [["weight"], ["max_weight"], ["values", "0"]],
    });
    if (!opened.ok) throw new Error(opened.reason);
    const signal = opened.value.created[0] as string;
    const read = v.store.read.bind(v.store);
    expect(signalByGid(read, signal)?.payload).toEqual(candidate(0.18).payload);
    v.value(applySignalActions, {
      run,
      actions: [{ type: "refresh", signal, candidate: candidate(0.21), seenAt: NOW }],
    });
    expect(signalByGid(read, signal)?.payload).toEqual(candidate(0.21).payload);
  });
});
