/** Actual native commands, buffered privacy boundary and actual Python synthetic byte oracle. */
import { parseDateTime, sha256Hex } from "@cashu/domain";
import { asProfileId } from "@cashu/domain/investments";
import {
  investmentsCommands as C,
  type Command,
  runCommand,
  investmentsServices as S,
  type v1,
} from "@cashu/store";
import * as Q from "@cashu/store/investments/queries";
import { afterEach, describe, expect, it } from "vitest";
import { Labelled } from "../privacy/labels.js";
import { type JsonValue, pyDumps } from "../privacy/pyJson.js";
import { investmentWriteServices } from "../providers/investmentWrites.js";
import type { ToolContext } from "../registry.js";
import { decodeEntityRef, type EntityRefKind, encodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer, type NativeRuntime, restrictivePrivacy } from "../runtime/server.js";
import { NATIVE_TOOL_SCHEMAS } from "../runtime/toolSchemas.generated.js";
import type { NativeToolStore } from "../runtime/types.js";
import { nativeFixture } from "../testing/native.js";
import vectors from "./fixtures/investmentWrites.json" with { type: "json" };
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
function normalized(tree: unknown, refs: ReadonlyMap<string, string>): JsonValue {
  if (Array.isArray(tree)) return tree.map((v) => normalized(v, refs));
  if (tree && typeof tree === "object")
    return Object.fromEntries(
      Object.entries(tree).map(([key, value]) => {
        const kinds: Readonly<Record<string, EntityRefKind>> = {
          instrument_id: "instrument",
          thesis_id: "thesis",
          signal_id: "signal",
          decision_id: "decision",
          alert_id: "alert",
          item_id: "watchlist",
          proposal_id: "proposal",
        };
        const kind = kinds[key];
        if (kind !== undefined && value !== null) {
          if (typeof value !== "string") throw new Error("native reference is not opaque");
          decodeEntityRef(kind, value);
          const declared = refs.get(value);
          if (declared === undefined) throw new Error("native reference was not declared");
          return [key, declared];
        }
        return [key, normalized(value, refs)];
      }),
    );
  if (
    tree === null ||
    typeof tree === "string" ||
    typeof tree === "number" ||
    typeof tree === "boolean" ||
    typeof tree === "bigint"
  )
    return tree;
  throw new Error("unexpected unlabelled response");
}
describe("native MCP local investment writes", () => {
  it("matches actual Python unified-diff counts including autojunk and header-like data", () => {
    for (const vector of vectors.diffs)
      expect(S.proposalDiffStats(vector.old, vector.next)).toEqual(vector.expected);
  });
  it("matches actual Python primitive reason normalization and astral limits, while MCP keeps its raw input cap", async () => {
    const s = await setup();
    for (const vector of vectors.strict.reason_vectors) {
      const out = s.f.run(C.setInstrumentPlan, {
        instrument: s.instrument,
        held: true,
        plan: vector.plan,
        reason: vector.reason,
      });
      const stored = Q.loadInstrument(s.f.store.read.bind(s.f.store), s.instrument);
      expect(
        { accepted: out.ok, reason: stored?.planReason ?? null, plan: stored?.plan ?? null },
        vector.label,
      ).toEqual(vector.expected);
    }
    const before = s.batches.length;
    expect(
      (
        await s.server.call("set_recommendation", {
          instrument: "ABC",
          recommendation: "buy",
          reason: `A${" ".repeat(300)}B`,
        })
      ).errorKind,
    ).toBe("invalid_arguments");
    expect(s.batches.length).toBe(before);
  });
  it("registers fourteen contracts with bounded async families and declared native reference adaptations", () => {
    const tools = investmentWriteTools();
    expect(tools).toHaveLength(14);
    expect(tools.some((t) => t.name === "search_instruments" || t.name === "propose_import")).toBe(
      true,
    );
    for (const tool of tools) {
      const source = NATIVE_TOOL_SCHEMAS.find((t) => t.name === tool.name);
      expect(source).toBeDefined();
      expect(tool.description).toBe(source?.description);
      expect(tool.write).toBe(source?.write);
    }
  });
  for (const privacy of ["strict", "amounts"] as const)
    it(`matches actual Python source responses and persisted state in ${privacy}`, async () => {
      const s = await setup(privacy),
        responses: Record<string, unknown> = {},
        refs = new Map<string, string>([
          [encodeEntityRef("instrument", s.instrument), "instrument"],
        ]);
      const call = async (name: string, tool: string, args: Record<string, unknown>) => {
        const result = data(await s.server.call(tool, args));
        responses[name] = result;
        return result;
      };
      await call("recommend", "set_recommendation", {
        instrument: "ABC",
        recommendation: "buy",
        reason: "Current source facts",
      });
      await call("coverage", "set_recommendations", { scope: "held", recommendations: [] });
      const thesis = await call("thesis", "upsert_thesis", {
        instrument: "ABC",
        entry_type: "trend",
        thesis: "Popyt utrzymuje się przez cykl.",
      });
      refs.set(String(thesis.thesis_id), "thesis");
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
      refs.set(String(alert.alert_id), "alert");
      await call("alerts", "alerts", {});
      await call("mute", "mute_alert", { id: alert.alert_id });
      const watched = await call("add_watch", "add_to_watchlist", {
        symbol_or_isin: "ABC",
        note: "Synthetic watch note",
      });
      const item = watched.item as Record<string, unknown>;
      refs.set(String(item.item_id), "item");
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
      refs.set(signalRef, "signal");
      const decided = await call("decision", "record_decision", {
        signal_id: signalRef,
        action: "held",
        reason: "Review recorded",
      });
      refs.set(String(decided.decision_id), "decision");
      await call("strategy_dry", "propose_strategy", { yaml: YAML, dry_run: true });
      await call("strategy_invalid", "propose_strategy", { yaml: "version: 99\n", dry_run: true });
      const strategy = await call("strategy", "propose_strategy", {
        yaml: YAML,
        reason: "Synthetic proposal",
      });
      refs.set(String(strategy.proposal_id), "strategy_proposal");
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
      refs.set(String(rule.proposal_id), "rule_proposal");
      expect(pyDumps(normalized(responses, refs), { sortKeys: true })).toBe(vectors[privacy].wire);
      expect({
        recommendation: Q.loadInstrument(s.f.store.read.bind(s.f.store), s.instrument)?.plan,
        theses: Q.theses(s.f.store.read.bind(s.f.store)).length,
        decisions: Q.decisions(s.f.store.read.bind(s.f.store)).length,
        signal_status: Q.signalByGid(s.f.store.read.bind(s.f.store), signal)?.status,
      }).toEqual(vectors[privacy].state);
    });
  it("keeps base recommendation/thesis writes without the optional plan provider", async () => {
    const s = await setup();
    s.noProvider();
    expect(
      (
        await s.server.call("set_recommendation", {
          instrument: "ABC",
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
  it("matches actual Python batch refusal codes and validation order without effects", async () => {
    const s = await setup();
    const changed = { instrument: "ABC", recommendation: "buy", reason: "Current facts" };
    const check = async (
      label: keyof typeof vectors.strict.errors,
      scope: string,
      recommendations: unknown[],
    ) => {
      const out = await s.server.call("set_recommendations", { scope, recommendations });
      expect({ error_kind: out.errorKind, error: out.error }).toEqual(vectors.strict.errors[label]);
    };
    await check("duplicate", "held", [changed, changed]);
    await check("outside", "watchlist", [changed]);
    await check("enum", "held", [{ ...changed, recommendation: "sell" }]);
    for (const symbol of ["OTHER", "THIRD"])
      value(s.f, C.addToWatchlist, {
        target: {
          planned: { symbol, name: `${symbol} public`, currency: "PLN", assetClass: "equity" },
        },
      });
    const reducing = { instrument: "OTHER", recommendation: "reduce", reason: "Current facts" };
    await check("coverage_before_held", "watchlist", [reducing]);
    await check("held_after_coverage", "watchlist", [
      reducing,
      { instrument: "THIRD", recommendation: "hold", reason: "Current facts" },
    ]);
    expect(s.batches).toHaveLength(0);
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
