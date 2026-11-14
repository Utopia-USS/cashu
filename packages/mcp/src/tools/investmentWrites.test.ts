// The local investment write tools over NativeMcpServer: each write lands as events only after the
// privacy boundary accepted its answer, proposals wait for the owner, and refused calls append nothing.
import { parseDateTime, sha256Hex } from "@cashu/domain";
import { asProfileId } from "@cashu/domain/investments";
import {
  investmentsCommands as C,
  type Command,
  runCommand,
  investmentsServices as S,
  type v1,
} from "@cashu/store";
import { proposalExecution } from "@cashu/store/core";
import * as Q from "@cashu/store/investments/queries";
import { afterEach, describe, expect, it } from "vitest";
import { Labelled } from "../privacy/labels.js";
import { type JsonValue, pyDumps } from "../privacy/pyJson.js";
import { investmentWriteServices } from "../providers/investmentWrites.js";
import type { ToolContext } from "../registry.js";
import { decodeEntityRef, encodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer, type NativeRuntime, restrictivePrivacy } from "../runtime/server.js";
import type { NativeToolStore } from "../runtime/types.js";
import { nativeFixture } from "../testing/native.js";
import { createdAlertView } from "./alerts.js";
import { investmentWriteTools } from "./investmentWrites.js";

const YAML = "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n";
const opened: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});
function value<I, V>(
  f: ReturnType<typeof nativeFixture>,
  command: Command<I, V>,
  input: unknown,
): V {
  const out = f.run(command, input);
  if (!out.ok) throw new Error(out.reason);
  return out.value;
}
async function setup(privacy: "strict" | "amounts" = "strict") {
  const f = nativeFixture();
  opened.push(f);
  const account = value(f, C.addBrokerageAccount, {
    name: "Synthetic broker",
    broker: "dif",
  }).account;
  const content = new TextEncoder().encode(
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n1,txn,2026-01-01,,buy,B,ABC,PLABC0000016,Synthetic quoted holding,XWAR,10,100,PLN,1000,0,0,-1000,PLN,,,generic_csv\n",
  );
  value(f, C.commitImport, {
    account,
    file: { name: "history.csv", content },
    archive: { sha256: sha256Hex(content), ext: "csv" },
  });
  const instrument = Q.allInstruments(f.store.read.bind(f.store)).find(
    (i) => i.symbol === "ABC",
  )?.id;
  if (!instrument) throw new Error("synthetic import instrument missing");
  const strategy = await S.loadStrategy(f.store, {
    read: async (name) => (name === "strategy.yaml" ? YAML : null),
    write: async () => {},
    exists: async () => true,
  });
  let withProvider = true,
    holder = false,
    filesCurrent = true,
    constructions = 0,
    currentYaml = YAML,
    foreignFiles = false,
    fileReads = 0,
    provideFiles = true;
  const batches: (readonly v1.Envelope[])[] = [];
  const runtime: NativeRuntime = {
    now: f.env.clock.now,
    replaced: () => false,
    warn: () => {},
    policy: async () => ({ privacy, modules: new Set(["investments"]) }),
    audit: { start: async () => 1, finish: async () => {} },
    execute: async (ceiling, fn) => {
      const base = f.context(restrictivePrivacy(privacy, ceiling)),
        pending: v1.Envelope[] = [];
      let context: ToolContext<NativeToolStore>,
        services: NativeToolStore["investmentWrites"],
        resolved = false;
      const store: NativeToolStore = {
        ...base.store,
        toolInventory: investmentWriteTools(),
        get investmentWrites() {
          if (!resolved) {
            resolved = true;
            if (withProvider) {
              constructions++;
              services = investmentWriteServices(context, {
                portfolio: {
                  vault: asProfileId(f.vault),
                  asOf: context.today,
                  clock: {
                    today: context.today,
                    now: parseDateTime(new Date(store.now()).toISOString()),
                    timeZone: "UTC",
                  },
                  strategy,
                  lang: "pl",
                  forOwner: false,
                  prices: f.prices,
                },
                isHolder: () => holder,
                ...(provideFiles
                  ? {
                      strategyFiles: {
                        vault: f.vault,
                        isCurrent: () => filesCurrent,
                        read: () => {
                          fileReads++;
                          return { yaml: currentYaml, md: null };
                        },
                      },
                    }
                  : {}),
              });
              if (foreignFiles)
                services = {
                  ...services,
                  strategyFiles: {
                    vault: "22222222222222222222222222222222",
                    isCurrent: () => true,
                    read: () => {
                      fileReads++;
                      return { yaml: currentYaml, md: null };
                    },
                  },
                };
            }
          }
          return services;
        },
        run: (command, input) =>
          runCommand(
            f.store,
            { append: (events) => pending.push(...events) },
            command,
            input,
            f.env,
          ),
      };
      context = { ...base, store };
      return fn({
        context,
        policy: { privacy, modules: new Set(["investments"]) },
        commit() {
          batches.push([...pending]);
          f.store.applyEnvelopes(pending);
        },
      });
    },
  };
  return {
    f,
    instrument,
    account,
    batches,
    runtime,
    server: new NativeMcpServer(runtime, investmentWriteTools()),
    noProvider: () => {
      withProvider = false;
    },
    holder: () => {
      holder = true;
    },
    staleFiles: () => {
      filesCurrent = false;
    },
    constructions: () => constructions,
    files: (yaml: string) => {
      currentYaml = yaml;
    },
    foreignFiles: () => {
      foreignFiles = true;
    },
    noFiles: () => {
      provideFiles = false;
    },
    fileReads: () => fileReads,
  };
}
const data = (out: Awaited<ReturnType<NativeMcpServer["call"]>>) => {
  if (!out.ok) throw new Error(`${out.errorKind}: ${out.error}`);
  return out.data as Record<string, unknown>;
};
describe("native MCP local investment writes", () => {
  it("counts proposal diff lines, header-like data included", () => {
    expect(S.proposalDiffStats(null, "alpha\nbeta\n")).toEqual({
      lines_added: 2,
      lines_removed: 0,
    });
    expect(S.proposalDiffStats("--literal\nx\n", "++literal\ny\n")).toEqual({
      lines_added: 1,
      lines_removed: 1,
    });
  });
  it("refuses a reason over the raw input cap before any write", async () => {
    const s = await setup();
    expect(
      (
        await s.server.call("set_recommendation", {
          instrument: "ABC",
          strength: "strong",
          strength_basis: "on_track",
          recommendation: "buy",
          reason: `A${" ".repeat(300)}B`,
        })
      ).errorKind,
    ).toBe("invalid_arguments");
    expect(s.batches).toHaveLength(0);
  });
  it("runs the write flow: recommendation, thesis, alert, watch, decision and owner proposals", async () => {
    const s = await setup(),
      responses: Record<string, Record<string, unknown>> = {};
    const call = async (name: string, tool: string, args: Record<string, unknown>) => {
      // the wire form the agent reads (integers as JSON numbers)
      const result = JSON.parse(pyDumps(data(await s.server.call(tool, args)) as JsonValue));
      responses[name] = result;
      return result as Record<string, unknown>;
    };
    await call("recommend", "set_recommendation", {
      instrument: "ABC",
      strength: "strong",
      strength_basis: "on_track",
      recommendation: "buy",
      reason: "Current source facts",
    });
    await call("coverage", "set_recommendations", { scope: "held", recommendations: [] });
    const thesis = await call("thesis", "upsert_thesis", {
      instrument: "ABC",
      entry_type: "trend",
      thesis: "Popyt utrzymuje się przez cykl.",
    });
    await call("thesis_update", "upsert_thesis", {
      instrument: "ABC",
      entry_type: "trend",
      thesis: "Popyt utrzymuje się przez cykl.",
      exit_plan: "Review at the next disclosure",
    });
    const added = await call("add_alert", "add_alert", {
      kind: "price_below",
      params: { level: 90 },
      polarity: "negative",
      severity: "info",
      title: "Synthetic price condition",
      instrument: "ABC",
      tag: "cena",
    });
    const alert = added.alert as Record<string, unknown>;
    await call("alerts", "alerts", {});
    await call("mute", "mute_alert", { id: alert.alert_id });
    const watched = await call("add_watch", "add_to_watchlist", {
      symbol_or_isin: "ABC",
      note: "Synthetic watch note",
    });
    const item = watched.item as Record<string, unknown>;
    await call("watchlist", "watchlist", {});
    await call("remove_watch", "remove_from_watchlist", { id: item.item_id });
    const signal = value(s.f, C.applySignalActions, {
      run: null,
      actions: [
        {
          type: "create",
          createdAt: new Date(s.f.env.clock.now()).toISOString(),
          candidate: {
            ruleId: "synthetic_rule",
            kind: "synthetic",
            dedupKey: `synthetic_rule|i:${s.instrument}`,
            severity: "info",
            message: "Synthetic journal signal",
            instrument: s.instrument,
          },
        },
      ],
    }).created[0];
    if (!signal) throw new Error("signal missing");
    const signalRef = encodeEntityRef("signal", signal);
    await call("decision", "record_decision", {
      signal_id: signalRef,
      action: "held",
      reason: "Review recorded",
    });
    await call("strategy_dry", "propose_strategy", { yaml: YAML, dry_run: true });
    await call("strategy_invalid", "propose_strategy", { yaml: "version: 99\n", dry_run: true });
    const strategy = await call("strategy", "propose_strategy", {
      yaml: YAML,
      reason: "Synthetic proposal",
    });
    await call("rule_dry", "propose_custom_rule", {
      kind_or_expression: "cash_level",
      params: { max_weight: 0.5 },
      dry_run: true,
    });
    await call("rule_invalid", "propose_custom_rule", {
      kind_or_expression: "cash_weight >",
      dry_run: true,
    });
    const rule = await call("rule", "propose_custom_rule", {
      kind_or_expression: "cash_level",
      params: { max_weight: 0.5 },
      reason: "Synthetic rule proposal",
    });
    // summary_params: the values of the app's localized proposal line.
    const summaryParams = (ref: unknown) =>
      proposalExecution(s.f.store.read.bind(s.f.store), decodeEntityRef("proposal", String(ref)))
        ?.payload.summary_params;
    expect(summaryParams(strategy.proposal_id)).toEqual({
      rules: Number(strategy.rules),
      buckets: (strategy.buckets as unknown[]).length,
      inactive_rules: 0,
    });
    expect(summaryParams(rule.proposal_id)).toMatchObject({ rule_kind: "cash_level" });
    expect(Object.keys(summaryParams(rule.proposal_id) as object)).toEqual([
      "rule_id",
      "rule_kind",
      "episodes",
      "evaluated",
    ]);
    const instrument = encodeEntityRef("instrument", s.instrument);
    expect(responses.recommend).toMatchObject({
      instrument_id: instrument,
      strength: "strong",
      strength_basis: "on_track",
      recommendation: "buy",
      reason_saved: true,
    });
    expect(responses.coverage).toMatchObject({ covered: 1, expected: 1, missing: 0, updated: 0 });
    expect(responses.thesis).toMatchObject({ created: true, instrument_id: instrument });
    expect(responses.thesis_update).toMatchObject({ created: false, thesis_id: thesis.thesis_id });
    expect(alert).toMatchObject({
      kind: "price_below",
      params: { level: 90.0 },
      status: "active",
      created_by: "mcp",
      instrument: { symbol: "ABC", isin: "[account]" },
    });
    expect(responses.alerts?.alerts).toEqual([alert]);
    expect(responses.mute).toEqual({ alert_id: alert.alert_id, status: "muted" });
    expect(item).toMatchObject({
      note: "Synthetic watch note",
      held: true,
      recommendation: "buy",
      strength: "strong",
      strength_basis: "on_track",
    });
    expect(responses.watchlist?.items).toEqual([item]);
    expect(responses.remove_watch).toEqual({ item_id: item.item_id, removed: true });
    expect(responses.decision).toMatchObject({
      action: "held",
      signal_id: signalRef,
      signal_status: "acknowledged",
    });
    expect(responses.strategy_dry).toMatchObject({ dry_run: true, stored: false, valid: true });
    expect(responses.strategy_invalid).toMatchObject({
      stored: false,
      valid: false,
      error_code: "invalid_strategy",
    });
    // a strict system message carries no number
    expect(
      (responses.strategy_invalid?.issues as { message: string }[] | undefined)?.[0]?.message,
    ).toBe("Unsupported version # (supported: #)");
    expect(responses.strategy).toMatchObject({ stored: true, valid: true, dry_run: false });
    expect(responses.rule_dry).toMatchObject({ stored: false, valid: true, kind: "cash_level" });
    expect(responses.rule_invalid).toMatchObject({ stored: false, valid: false });
    expect(rule).toMatchObject({ stored: true, valid: true, rule_id: "agent_cash_level_1" });
    expect({
      recommendation: Q.loadInstrument(s.f.store.read.bind(s.f.store), s.instrument)?.plan,
      theses: Q.theses(s.f.store.read.bind(s.f.store)).length,
      decisions: Q.decisions(s.f.store.read.bind(s.f.store)).length,
      signal_status: Q.signalByGid(s.f.store.read.bind(s.f.store), signal)?.status,
    }).toEqual({ recommendation: "buy", theses: 1, decisions: 1, signal_status: "acknowledged" });
  });
  it("keeps the numbers of a system message in amounts mode", async () => {
    const s = await setup("amounts");
    const out = data(
      await s.server.call("propose_strategy", { yaml: "version: 99\n", dry_run: true }),
    );
    expect((out.issues as { message: string }[])[0]?.message).toBe(
      "Unsupported version 99 (supported: 1)",
    );
  });
  it("keeps base recommendation/thesis writes without the optional plan provider", async () => {
    const s = await setup();
    s.noProvider();
    expect(
      (
        await s.server.call("set_recommendation", {
          instrument: "ABC",
          strength: "strong",
          strength_basis: "on_track",
          recommendation: "buy",
          reason: "Updated facts",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await s.server.call("upsert_thesis", {
          instrument: "ABC",
          entry_type: "trend",
          thesis: "Current proposition",
        })
      ).ok,
    ).toBe(true);
    expect(s.constructions()).toBe(0);
    expect(
      Q.openSignals(s.f.store.read.bind(s.f.store)).filter((r) => r.ruleId.startsWith("plan:")),
    ).toHaveLength(0);
    const before = s.batches.length;
    expect((await s.server.call("add_to_watchlist", { symbol_or_isin: "ABC" })).errorKind).toBe(
      "unsupported",
    );
    expect(s.batches.length).toBe(before);
  });
  it("prospective saved-to-watched hints and semantic row equal the actual persisted projection", async () => {
    const s = await setup();
    const saved = value(s.f, C.createInstrument, {
      name: "Saved public instrument",
      symbol: "SAVED",
      currency: "PLN",
      assetClass: "equity",
    }).gid;
    value(s.f, C.setInstrumentPlan, { instrument: saved, plan: "buy", held: false });
    const added = data(
      await s.server.call("add_to_watchlist", {
        symbol_or_isin: encodeEntityRef("instrument", saved),
        note: "Prospective note",
      }),
    );
    const item = added.item as Record<string, unknown>;
    expect((item.hints as { code: string }[]).map((h) => h.code)).toEqual([
      "plan_without_thesis",
      "no_thesis",
    ]);
    const listed = data(await s.server.call("watchlist"));
    const persisted = (listed.items as Record<string, unknown>[]).find(
      (row) => row.item_id === item.item_id,
    );
    expect(pyDumps(persisted as JsonValue, { sortKeys: true })).toBe(
      pyDumps(item as JsonValue, { sortKeys: true }),
    );
  });
  it("rejects foreign, forged and wrong-kind refs and incomplete batches without append", async () => {
    const s = await setup(),
      before = s.batches.length;
    for (const id of [
      encodeEntityRef("instrument", s.instrument),
      "signal:ubad",
      encodeEntityRef("signal", "01JF0000000000000000000000"),
    ])
      expect((await s.server.call("record_decision", { signal_id: id, action: "held" })).ok).toBe(
        false,
      );
    expect(
      (await s.server.call("set_recommendations", { scope: "held", recommendations: [] }))
        .errorKind,
    ).toBe("incomplete_coverage");
    expect(s.batches.length).toBe(before);
  });
  it("late privacy refusal discards prospective alert and its full response", async () => {
    const s = await setup();
    const original = investmentWriteTools().find((tool) => tool.name === "add_alert");
    if (!original) throw new Error("missing alert tool");
    const server = new NativeMcpServer(s.runtime, [
      {
        ...original,
        handler: async (ctx, args) => ({
          actual: await original.handler(ctx, args),
          invalid: new Labelled("not a count", "count"),
        }),
      },
    ]);
    const out = await server.call("add_alert", {
      kind: "price_below",
      params: { level: 90 },
      polarity: "negative",
      severity: "info",
      title: "Synthetic price condition",
      instrument: "ABC",
    });
    expect(out.ok).toBe(false);
    expect(s.batches).toHaveLength(0);
    expect(
      Q.alerts(s.f.store.read.bind(s.f.store), new Date(s.f.env.clock.now()).toISOString()),
    ).toHaveLength(0);
  });
  it("replies to add_alert with fractional params as numbers, like the committed row", async () => {
    const s = await setup();
    const out = await s.server.call("add_alert", {
      kind: "price_below",
      params: { level: 90.25 },
      polarity: "negative",
      severity: "info",
      title: "Synthetic price condition",
      instrument: "ABC",
    });
    expect(out.ok).toBe(true);
    const row = Q.alerts(
      s.f.store.read.bind(s.f.store),
      new Date(s.f.env.clock.now()).toISOString(),
    )[0];
    expect(row?.params).toEqual({ level: 90.25 });
    // The reply row is built from the emitted event, whose blob carries 90.25 as Decimal text.
    const event = s.batches.flat().find((e) => e.type === "alert.created");
    if (event === undefined) throw new Error("no alert event");
    expect(event.data.paramsFloats).toEqual([["level"]]);
    expect(createdAlertView(event, row?.instrument ?? null, "2026-01-01T00:00:00Z").params).toEqual(
      row?.params,
    );
  });
  it("rejects stale file authority before proposal effects and leaves dry runs empty", async () => {
    const s = await setup();
    expect((await s.server.call("propose_strategy", { yaml: YAML, dry_run: true })).ok).toBe(true);
    expect(s.batches.flat()).toHaveLength(0);
    s.staleFiles();
    expect((await s.server.call("propose_strategy", { yaml: YAML })).ok).toBe(false);
    expect(s.batches.flat()).toHaveLength(0);
  });
  it("preserves local watch conflicts and invalid/explicit reference errors without effects", async () => {
    const s = await setup();
    data(await s.server.call("add_to_watchlist", { symbol_or_isin: "ABC" }));
    const before = s.batches.length;
    expect((await s.server.call("add_to_watchlist", { symbol_or_isin: "ABC" })).errorKind).toBe(
      "conflict",
    );
    expect(
      (await s.server.call("add_to_watchlist", { symbol_or_isin: "A".repeat(41) })).errorKind,
    ).toBe("invalid_arguments");
    for (const ref of [
      encodeEntityRef("alert", s.instrument),
      "instrument:ubad",
      encodeEntityRef("instrument", "01JF0000000000000000000000"),
    ])
      expect((await s.server.call("add_to_watchlist", { symbol_or_isin: ref })).errorKind).toBe(
        "not_found",
      );
    expect(
      (await s.server.call("add_to_watchlist", { symbol_or_isin: "UNKNOWN.US" })).errorKind,
    ).toBe("unsupported");
    value(s.f, C.addToWatchlist, {
      target: {
        planned: {
          symbol: "ABC",
          name: "Another synthetic listing",
          currency: "EUR",
          assetClass: "equity",
          isin: "DE0000000001",
          mic: "XETR",
        },
      },
    });
    expect((await s.server.call("add_to_watchlist", { symbol_or_isin: "ABC" })).errorKind).toBe(
      "invalid",
    );
    expect(s.batches.length).toBe(before);
  });
  it("refuses invalid recommendation batches in validation order without effects", async () => {
    const s = await setup();
    const assessed = { strength: "neutral", strength_basis: "no_progress" };
    const changed = {
      instrument: "ABC",
      ...assessed,
      recommendation: "buy",
      reason: "Current facts",
    };
    const ERRORS = {
      duplicate: ["invalid_arguments", "recommendations[1] duplicates an instrument"],
      outside: ["invalid_arguments", "recommendations[0] is outside the selected watchlist scope"],
      enum: [
        "invalid_arguments",
        "recommendations[0].recommendation must be one of: buy_asap, buy, hold, reduce, exit_asap (or omitted)",
      ],
      no_strength: [
        "invalid_arguments",
        "recommendations[0].strength is required, one of: strong, neutral, weak",
      ],
      no_basis: [
        "invalid_arguments",
        "recommendations[0].strength_basis is required, one of: on_track, fulfilled, undermined, environment_against, no_progress",
      ],
      coverage_before_held: [
        "incomplete_coverage",
        "strength coverage incomplete: expected 2, covered 1, missing 1; see research_context for rows with strength null",
      ],
      held_after_coverage: ["invalid", "Plan 'reduce' needs a held instrument"],
      strength_vs_basis: [
        "invalid_arguments",
        "recommendations[1].strength_basis 'fulfilled' needs strength weak",
      ],
      plan_vs_strength: [
        "invalid_arguments",
        "recommendations[1].recommendation 'buy' contradicts strength 'weak' (buy / buy_asap never with weak, reduce / exit_asap never with strong)",
      ],
    } as const;
    const check = async (label: keyof typeof ERRORS, scope: string, recommendations: unknown[]) => {
      const out = await s.server.call("set_recommendations", { scope, recommendations });
      expect([out.errorKind, out.error]).toEqual(ERRORS[label]);
    };
    await check("duplicate", "held", [changed, changed]);
    await check("outside", "watchlist", [changed]);
    await check("enum", "held", [{ ...changed, recommendation: "sell" }]);
    await check("no_strength", "held", [{ ...changed, strength: undefined }]);
    await check("no_basis", "held", [{ ...changed, strength_basis: "unknown" }]);
    for (const symbol of ["OTHER", "THIRD"])
      value(s.f, C.addToWatchlist, {
        target: {
          planned: { symbol, name: `${symbol} public`, currency: "PLN", assetClass: "equity" },
        },
      });
    // a stored recommendation without a strength does not cover THIRD
    const third = Q.loadInstruments(
      s.f.store.read.bind(s.f.store),
      Q.watchedInstrumentGids(s.f.store.read.bind(s.f.store)),
    );
    for (const [id, inst] of third)
      if (inst.symbol === "THIRD")
        value(s.f, C.setInstrumentPlan, { instrument: id, plan: "hold", held: false });
    const reducing = {
      instrument: "OTHER",
      ...assessed,
      recommendation: "reduce",
      reason: "Current facts",
    };
    await check("coverage_before_held", "watchlist", [reducing]);
    const thirdRow = { instrument: "THIRD", reason: "Current facts" };
    await check("held_after_coverage", "watchlist", [reducing, { ...thirdRow, ...assessed }]);
    const other = { instrument: "OTHER", ...assessed, reason: "Current facts" };
    await check("strength_vs_basis", "watchlist", [
      other,
      { ...thirdRow, strength: "strong", strength_basis: "fulfilled" },
    ]);
    await check("plan_vs_strength", "watchlist", [
      other,
      { ...thirdRow, strength: "weak", strength_basis: "undermined", recommendation: "buy" },
    ]);
    const batches = s.batches.length;
    const single = await s.server.call("set_recommendation", {
      instrument: "ABC",
      strength: "strong",
      strength_basis: "on_track",
      recommendation: "exit_asap",
      reason: "Current facts",
    });
    expect([single.errorKind, single.error]).toEqual([
      "invalid_arguments",
      "recommendation 'exit_asap' contradicts strength 'strong' (buy / buy_asap never with weak, reduce / exit_asap never with strong)",
    ]);
    expect(
      (
        await s.server.call("set_recommendation", {
          instrument: "ABC",
          strength: "weak",
          reason: "x",
        })
      ).error,
    ).toBe("missing argument: strength_basis");
    expect(s.batches).toHaveLength(batches);
    expect(batches).toBe(0);
  });
  it("a strength-only assessment clears an older recommendation and covers the gate", async () => {
    const s = await setup();
    value(s.f, C.setInstrumentPlan, { instrument: s.instrument, plan: "buy", held: true });
    const out = data(
      await s.server.call("set_recommendation", {
        instrument: "ABC",
        strength: "weak",
        strength_basis: "environment_against",
        reason: "Otoczenie rynkowe działa przeciw tezie.",
      }),
    );
    expect(out).toMatchObject({
      strength: "weak",
      strength_basis: "environment_against",
      recommendation: null,
      reason_saved: true,
    });
    const inst = Q.loadInstrument(s.f.store.read.bind(s.f.store), s.instrument);
    expect([inst?.plan, inst?.positionStrength, inst?.strengthReason]).toEqual([
      null,
      "weak",
      "Otoczenie rynkowe działa przeciw tezie.",
    ]);
    expect(
      data(await s.server.call("set_recommendations", { scope: "held", recommendations: [] })),
    ).toMatchObject({ expected: 1n, covered: 1n, missing: 0n, updated: 0n });
    // the watchlist row carries the strength and the held position_weak hint
    const item = data(await s.server.call("add_to_watchlist", { symbol_or_isin: "ABC" }))
      .item as Record<string, unknown>;
    expect(item).toMatchObject({
      recommendation: null,
      strength: "weak",
      strength_basis: "environment_against",
    });
    expect((item.hints as { code: string }[]).map((h) => h.code)).toContain("position_weak");
  });
  it("uses current file bucket identities in both directions, not historical stored versions", async () => {
    const s = await setup();
    const bucketYaml =
      YAML +
      "buckets:\n  - id: current\n    match: {asset_class: [equity]}\nallocation: {targets: {current: 1.0}}\n";
    const args = {
      kind: "weight_above",
      scope: "bucket",
      params: { threshold: 0.3, bucket: "current" },
      polarity: "neutral",
      severity: "info",
      title: "Synthetic bucket condition",
    };
    value(s.f, C.saveStrategyVersion, { yamlText: YAML, mdText: null });
    s.files(bucketYaml);
    expect((await s.server.call("add_alert", args)).ok).toBe(true);
    value(s.f, C.saveStrategyVersion, { yamlText: bucketYaml, mdText: null });
    s.files(YAML);
    const before = s.batches.length;
    expect((await s.server.call("add_alert", args)).ok).toBe(false);
    expect(s.batches.length).toBe(before);
  });
  it.each(["absent", "stale", "foreign"])(
    "refuses bucket file authority %s before reads/effects while ordinary alerts remain independent",
    async (mode) => {
      const s = await setup();
      if (mode === "absent") s.noFiles();
      if (mode === "stale") s.staleFiles();
      if (mode === "foreign") s.foreignFiles();
      const bucket = {
        kind: "weight_above",
        scope: "bucket",
        params: { threshold: 0.3, bucket: "current" },
        polarity: "neutral",
        severity: "info",
        title: "Synthetic bucket condition",
      };
      expect((await s.server.call("add_alert", bucket)).ok).toBe(false);
      expect(s.fileReads()).toBe(0);
      expect(s.batches).toHaveLength(0);
      if (mode === "foreign")
        for (const [name, args] of [
          ["propose_strategy", { yaml: YAML, dry_run: true }],
          [
            "propose_custom_rule",
            { kind_or_expression: "cash_level", params: { max_weight: 0.5 }, dry_run: true },
          ],
        ] as const)
          expect((await s.server.call(name, args)).ok).toBe(false);
      expect(s.fileReads()).toBe(0);
      expect(s.batches).toHaveLength(0);
      // This nonbucket path never asks for the unrelated optional provider.
      expect(
        (
          await s.server.call("add_alert", {
            kind: "price_below",
            params: { level: 90 },
            instrument: "ABC",
            polarity: "negative",
            severity: "info",
            title: "Synthetic price condition",
          })
        ).ok,
      ).toBe(true);
    },
  );
});
