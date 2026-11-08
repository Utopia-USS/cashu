import { parseDateTime } from "@cashu/domain";
import { asProfileId, research } from "@cashu/domain/investments";
import { summaryOk } from "@cashu/domain/investments/macro";
import {
  investmentsCommands as C,
  type Command,
  investmentsResearch as R,
  runCommand,
  investmentsServices as S,
  setProfileSettings,
  type v1,
} from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import { afterEach, describe, expect, it } from "vitest";
import { Labelled, pct } from "../privacy/labels.js";
import { researchServices } from "../providers/research.js";
import type { ToolContext } from "../registry.js";
import { decodeEntityRef, encodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer, type NativeRuntime, restrictivePrivacy } from "../runtime/server.js";
import type { NativeToolStore } from "../runtime/types.js";
import { nativeFixture } from "../testing/native.js";
import { researchTools } from "./research.js";
import { object } from "./researchLabels.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function value<I, V>(
  f: ReturnType<typeof nativeFixture>,
  command: Command<I, V>,
  input: unknown,
): V {
  const result = f.run(command, input);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
const NOTE = {
  kind: "news",
  polarity: "negative",
  strength: 2,
  thesis_relation: "invalidates",
  thesis_field: "thesis",
  title: "Zakończono program współpracy operacyjnej",
  summary: "Spółka zakończyła program współpracy, który stanowił podstawę opisanej tezy.",
  sources: [
    {
      url: "https://example.com/synthetic-disclosure",
      publisher: "Synthetic filings",
      published_at: "2026-11-01",
    },
  ],
};
/** Synthetic macro closes (weekdays up to `today`): every regime evaluates and carries metrics. */
function macroSeries(today: string): Record<string, (readonly [string, number])[]> {
  const days: string[] = [];
  for (let t = Date.parse(`${today}T00:00:00Z`) - 800 * 86_400_000; ; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day > today) break;
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(day);
  }
  const n = days.length,
    series = (f: (i: number) => number) =>
      days.map((day, i) => [day, Math.round(f(i) * 10_000) / 10_000] as const);
  return {
    acwi: series((i) => 100 + 0.05 * i),
    spx: series((i) => 5000 + 2 * i),
    dxy: series(() => 100),
    eem: series((i) => (100 + 0.05 * i) / 2),
    dbc: series((i) => 20 + 0.01 * i),
    us10y: series((i) => (i < n - 30 ? 4.2 : 4.7)),
    us3m: series(() => 4),
  };
}
async function setup(
  privacy = "strict",
  withProvider = true,
  options: {
    readonly lang?: "pl" | "en";
    readonly macro?: boolean;
    readonly patchMacro?: (
      card: ReturnType<NonNullable<NativeToolStore["research"]>["macro"]>[number],
    ) => ReturnType<NonNullable<NativeToolStore["research"]>["macro"]>[number];
  } = {},
) {
  const f = nativeFixture();
  fixtures.push(f);
  const account = value(f, C.addBrokerageAccount, {
    name: "Synthetic broker",
    broker: "dif",
  }).account;
  const watched = value(f, C.addToWatchlist, {
    target: {
      planned: {
        symbol: "ABC",
        isin: "PLABC0000016",
        name: "Synthetic quoted holding",
        currency: "PLN",
        assetClass: "equity",
        mic: "XWAR",
        aliases: [{ namespace: "yahoo", value: "ABC.WA" }],
      },
    },
  });
  const instrument = watched.instrument;
  value(f, C.addManualTransaction, {
    account,
    type: "deposit",
    tradeDate: "2026-01-01",
    cashAmount: "1000",
    currency: "PLN",
  });
  value(f, C.addManualTransaction, {
    account,
    instrument,
    type: "buy",
    tradeDate: "2026-01-01",
    quantity: "10",
    price: "100",
    cashAmount: "-1000",
    currency: "PLN",
  });
  value(f, C.createThesis, {
    instrument,
    entryType: "trend",
    thesis: "Popyt utrzymuje się przez cykl.",
  });
  value(f, C.setInstrumentPlan, { instrument, plan: "buy", reason: null, held: true });
  value(f, setProfileSettings, { mcpPrivacy: privacy });
  const strategy = await S.loadStrategy(f.store, {
    read: async (name) =>
      name === "strategy.yaml"
        ? "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n"
        : null,
    write: async () => {},
    exists: async () => true,
  });
  const batches: (readonly v1.Envelope[])[] = [];
  let holder = true,
    maliciousMacro = false;
  const policy = () => {
    const profile = mcpProfile(f.store.read.bind(f.store));
    return profile
      ? {
          privacy: profile.mcpPrivacy === "amounts" ? ("amounts" as const) : ("strict" as const),
          modules: new Set(profile.modules),
        }
      : undefined;
  };
  const runtime: NativeRuntime = {
    now: f.env.clock.now,
    replaced: () => false,
    warn: () => {},
    policy: async () => policy(),
    audit: { start: async () => 1, finish: async () => {} },
    execute: async (ceiling, fn) => {
      const p = policy();
      if (!p) return fn(undefined);
      const pending: v1.Envelope[] = [],
        base = f.context(restrictivePrivacy(p.privacy, ceiling));
      let services: NativeToolStore["research"];
      const store: NativeToolStore = {
        ...base.store,
        get research() {
          return services;
        },
        toolInventory: researchTools(),
        run: (command, input) =>
          runCommand(
            f.store,
            { append: (events) => pending.push(...events) },
            command,
            input,
            f.env,
          ),
      };
      const context: ToolContext<NativeToolStore> = { ...base, store };
      services = researchServices(context, {
        portfolio: {
          vault: asProfileId(f.vault),
          asOf: context.today,
          clock: {
            today: context.today,
            now: parseDateTime(new Date(store.now()).toISOString()),
            timeZone: "UTC",
          },
          strategy,
          lang: options.lang ?? "pl",
          forOwner: false,
          prices: f.prices,
        },
        macroCloses: options.macro ? macroSeries(context.today) : {},
        isHolder: () => holder,
      });
      if (maliciousMacro) {
        const original = services;
        services = {
          ...original,
          macro: () =>
            original.macro().map((card) => ({ ...card, summary: "Anna Nowak ma 123456789 zł." })),
        };
      }
      const patch = options.patchMacro;
      if (patch !== undefined && services !== undefined) {
        const original = services;
        services = { ...original, macro: () => original.macro().map(patch) };
      }
      if (!withProvider) services = undefined;
      return fn({
        context,
        policy: p,
        commit() {
          batches.push([...pending]);
          f.store.applyEnvelopes(pending);
        },
      });
    },
  };
  return {
    f,
    account,
    instrument,
    runtime,
    batches,
    server: new NativeMcpServer(runtime, researchTools()),
    loseAuthority: () => {
      holder = false;
    },
    maliciousMacro: () => {
      maliciousMacro = true;
    },
  };
}
/** One more quoted holding bought in the setup's account (optionally sold again / left watched). */
function holding(
  s: Awaited<ReturnType<typeof setup>>,
  symbol: string,
  isin: string,
  o: { readonly watched?: boolean; readonly thesis?: string; readonly sold?: boolean } = {},
): string {
  const added = value(s.f, C.addToWatchlist, {
    target: {
      planned: {
        symbol,
        isin,
        name: `Synthetic ${symbol}`,
        currency: "PLN",
        assetClass: "equity",
        mic: "XWAR",
      },
    },
  });
  value(s.f, C.addManualTransaction, {
    account: s.account,
    type: "deposit",
    tradeDate: "2026-01-02",
    cashAmount: "500",
    currency: "PLN",
  });
  value(s.f, C.addManualTransaction, {
    account: s.account,
    instrument: added.instrument,
    type: "buy",
    tradeDate: "2026-01-02",
    quantity: "5",
    price: "100",
    cashAmount: "-500",
    currency: "PLN",
  });
  if (o.thesis !== undefined)
    value(s.f, C.createThesis, {
      instrument: added.instrument,
      entryType: o.thesis,
      thesis: `Teza testowa ${symbol}.`,
    });
  if (o.sold)
    value(s.f, C.addManualTransaction, {
      account: s.account,
      instrument: added.instrument,
      type: "sell",
      tradeDate: "2026-01-05",
      quantity: "5",
      price: "100",
      cashAmount: "500",
      currency: "PLN",
    });
  if (!o.watched) value(s.f, C.removeFromWatchlist, { item: added.item });
  return added.instrument;
}
function body(result: Awaited<ReturnType<NativeMcpServer["call"]>>): Record<string, unknown> {
  if (!result.ok) throw new Error(`research tool refused: ${result.errorKind}: ${result.error}`);
  return Object.fromEntries(Object.entries(result.data ?? {}));
}
describe("native research MCP tools", () => {
  it.each(["strict", "amounts"])(
    "roundtrips run refs and commits the note with both signal families in %s",
    async (privacy) => {
      const s = await setup(privacy),
        start = body(await s.server.call("start_research_run", {})),
        run = start.run_id;
      expect(typeof run).toBe("string");
      const note = body(
        await s.server.call("add_research_note", {
          ...NOTE,
          instrument: encodeEntityRef("instrument", s.instrument),
          run_id: run,
        }),
      );
      expect(note.run_id).toBe(run);
      expect(note.instrument_id).toBe(encodeEntityRef("instrument", s.instrument));
      const batch = s.batches.at(-1) ?? [];
      expect(batch.some((event) => event.type === "note.added")).toBe(true);
      expect(batch.filter((event) => event.type === "signal.opened").length).toBeGreaterThanOrEqual(
        2,
      );
      expect(
        s.f.store
          .read<{ rule_id: string }>("SELECT rule_id FROM inv_signals")
          .some((row) => row.rule_id === "plan:plan_vs_thesis"),
      ).toBe(true);
      const finish = body(
        await s.server.call("finish_research_run", { run_id: run, counts: { sources_checked: 1 } }),
      );
      expect(finish.run_id).toBe(run);
      expect(finish.status).toBe("done");
      expect(start.status).toBe("running");
      expect(object(note.signal)).toMatchObject({ created: true, escalated: false });
      expect(object(finish.counts)).toMatchObject({ notes: 1n, signals: 1n, sources_checked: 1n });
      const errors = {
        no_scope: "a note is about an instrument (instrument) or a market segment (segment)",
        segment_only:
          "a segment note is about the market segment only; write instrument facts on the instrument",
      } as const;
      const { thesis_relation: _relation, thesis_field: _field, ...neutral } = NOTE;
      for (const [name, scope] of [
        ["no_scope", {}],
        ["segment_only", { segment: "energy", instrument: "ABC" }],
      ] as const) {
        const refused = await s.server.call("add_research_note", { ...neutral, ...scope });
        expect([refused.errorKind, refused.error]).toEqual(["invalid", errors[name]]);
      }
      const topic = body(
        await s.server.call("upsert_topic_thesis", {
          segment: "energy",
          thesis: "Podaż pozostaje ograniczona przez czas budowy nowych mocy.",
        }),
      );
      const invalidView = await s.server.call("set_topic_market_view", {
        segment: "energy",
        assessment: "",
        outlook: "",
        sources: [],
      });
      expect([invalidView.errorKind, invalidView.error]).toEqual([
        "invalid",
        "assessment: is required; outlook: is required; sources: at least one source is required: [{url, publisher, published_at}]",
      ]);
      const marketView = body(
        await s.server.call("set_topic_market_view", {
          segment: "energy",
          assessment: "Wykorzystanie mocy jest wysokie, a nowe projekty potrzebują czasu.",
          outlook:
            "Według raportu popyt na energię wzrośnie o 5% do 2028 r.; ryzykiem pozostają ograniczenia podaży.",
          sources: NOTE.sources,
        }),
      );
      const segment = body(
        await s.server.call("set_instrument_segment", {
          instrument: encodeEntityRef("instrument", s.instrument),
          segment: "energy",
        }),
      );
      expect(topic).toMatchObject({ created: true, draft: true, segment: "energy" });
      // strict hides a bare year-like number in agent text; amounts keeps it
      expect(marketView.outlook).toBe(
        `Według raportu popyt na energię wzrośnie o 5% do ${privacy === "strict" ? "[amount]" : "2028"} r.; ryzykiem pozostają ograniczenia podaży.`,
      );
      expect(segment).toMatchObject({ segment: "energy", segment_source: "agent" });
      expect({
        notes: s.f.store.read("SELECT gid FROM research_notes").length,
        signals: s.f.store
          .read<{ rule_id: string; status: string }>(
            "SELECT rule_id,status FROM inv_signals ORDER BY rule_id",
          )
          .map((row) => ({ rule: row.rule_id, status: row.status })),
        health: R.healthByInstrument(
          s.f.store.read.bind(s.f.store),
          [s.instrument],
          R.eventInstant(new Date(s.f.toolStore().now()).toISOString()),
        ).get(s.instrument)?.health.state,
      }).toEqual({
        notes: 1,
        signals: [
          { rule: "plan:plan_vs_thesis", status: "active" },
          { rule: "research:news", status: "active" },
        ],
        health: "invalidated",
      });
      const notes = body(await s.server.call("research_notes", {}));
      expect(Array.isArray(notes.notes)).toBe(true);
      if (Array.isArray(notes.notes)) expect(notes.notes).toHaveLength(1);
      const context = body(await s.server.call("research_context", {}));
      expect(context.as_of).toBe("2026-11-01");
      expect(context.running_run_id).toBeNull();
      expect(context.last_done_run).toMatchObject({ run_id: run });
    },
  );
  it("research_context carries the position strength of held rows", async () => {
    const s = await setup();
    let row = (
      body(await s.server.call("research_context", {})).positions as Record<string, unknown>[]
    )[0];
    expect(row).toMatchObject({ strength: null, strength_basis: null, strength_at: null });
    value(s.f, C.setInstrumentStrength, {
      instrument: s.instrument,
      strength: "neutral",
      basis: "no_progress",
      reason: "Teza bez postępu w tym kwartale.",
    });
    row = (
      body(await s.server.call("research_context", {})).positions as Record<string, unknown>[]
    )[0];
    expect(row).toMatchObject({ strength: "neutral", strength_basis: "no_progress" });
    expect(row?.strength_at).not.toBeNull();
  });
  it("rejects wrong-kind, foreign and numeric run references before writes", async () => {
    const s = await setup(),
      start = body(await s.server.call("start_research_run", {}));
    if (typeof start.run_id !== "string") throw new Error("missing run ref");
    const gid = decodeEntityRef("run", start.run_id),
      before = s.f.store.foreignEvents(0, new Set(), 1000).events.length;
    expect(
      (await s.server.call("finish_research_run", { run_id: encodeEntityRef("note", gid) }))
        .errorKind,
    ).toBe("not_found");
    expect(
      (
        await s.server.call("finish_research_run", {
          run_id: encodeEntityRef("run", "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        })
      ).errorKind,
    ).toBe("not_found");
    expect((await s.server.call("finish_research_run", { run_id: 1 })).errorKind).toBe(
      "invalid_arguments",
    );
    expect(s.f.store.foreignEvents(0, new Set(), 1000).events).toHaveLength(before);
    expect(
      (await s.server.call("add_research_note", { ...NOTE, instrument: "A".repeat(41) })).errorKind,
    ).toBe("invalid_arguments");
  });
  it("stores agent topic drafts, sourced industry views and direct segment assignments", async () => {
    const s = await setup();
    expect(
      body(
        await s.server.call("upsert_topic_thesis", {
          segment: "energy",
          thesis: "Podaż pozostaje ograniczona przez czas budowy nowych mocy.",
        }),
      ),
    ).toMatchObject({ segment: "energy", created: true, draft: true });
    const view = body(
      await s.server.call("set_topic_market_view", {
        segment: "energy",
        assessment: "Wykorzystanie mocy jest wysokie, a nowe projekty potrzebują czasu.",
        outlook:
          "Według raportu popyt na energię wzrośnie o 5% do 2028 r.; ryzykiem pozostają ograniczenia podaży.",
        sources: NOTE.sources,
      }),
    );
    expect(view).toMatchObject({ segment: "energy", thesis_draft: true });
    expect(Array.isArray(view.view_sources) && view.view_sources.length === 1).toBe(true);
    expect(
      body(
        await s.server.call("set_instrument_segment", {
          instrument: encodeEntityRef("instrument", s.instrument),
          segment: "energy",
        }),
      ),
    ).toMatchObject({ segment: "energy", segment_source: "agent" });
  });
  it("preserves owner segment/topic decisions and keeps source on unchanged owner segment", async () => {
    const s = await setup();
    value(s.f, C.setInstrumentSegment, {
      instrument: s.instrument,
      segment: "energy",
      by: "owner",
    });
    expect(
      body(await s.server.call("set_instrument_segment", { instrument: "ABC", segment: "energy" })),
    ).toMatchObject({ segment: "energy", segment_source: "owner" });
    expect(
      (await s.server.call("set_instrument_segment", { instrument: "ABC", segment: "quantum" }))
        .errorKind,
    ).toBe("conflict");
    value(s.f, R.saveTopicThesis, {
      segment: "energy",
      thesis: "Podaż pozostaje ograniczona.",
      draft: false,
      by: "owner",
    });
    expect(
      (
        await s.server.call("upsert_topic_thesis", {
          segment: "energy",
          thesis: "Nowa teza agenta.",
        })
      ).errorKind,
    ).toBe("conflict");
  });
  it("never appends the actual note+derived signals if final privacy rejects its labelled response", async () => {
    const s = await setup(),
      original = researchTools().find((spec) => spec.name === "add_research_note");
    if (!original) throw new Error("missing tool");
    const spec = {
      ...original,
      handler: async (
        ctx: ToolContext<NativeToolStore>,
        args: Readonly<Record<string, unknown>>,
      ) => ({
        actual: await original.handler(ctx, args),
        invalid: new Labelled("not a count", "count"),
      }),
    };
    const out = await new NativeMcpServer(s.runtime, [spec]).call("add_research_note", {
      ...NOTE,
      instrument: "ABC",
    });
    expect(out.errorKind).toBe("unlabelled");
    expect(s.f.store.read("SELECT gid FROM research_notes")).toHaveLength(0);
    expect(s.f.store.read("SELECT gid FROM inv_signals")).toHaveLength(0);
  });
  it.each(["pl", "en"] as const)(
    "research_context labels the macro metrics in the MCP's Polish market vocabulary (app language %s)",
    async (lang) => {
      const s = await setup("strict", true, { lang, macro: true }),
        result = await s.server.call("research_context", {});
      expect(result.errorKind ?? null).toBeNull();
      const cards = body(result).macro as Record<string, unknown>[];
      const metrics = cards.flatMap((card) => card.metrics as Record<string, unknown>[]);
      expect(metrics.length).toBeGreaterThan(0);
      for (const metric of metrics) {
        expect(String(metric.text)).not.toMatch(/\d\.\d/);
        expect(String(metric.label)).toMatch(/\S/);
      }
    },
  );
  it("drops a macro metric outside the market vocabulary instead of failing research_context", async () => {
    const s = await setup("strict", true, {
        macro: true,
        patchMacro: (card) => ({
          ...card,
          metrics: card.metrics.map((metric) => ({ ...metric, label: "1Y return", text: "+4.1%" })),
        }),
      }),
      result = await s.server.call("research_context", {});
    expect(result.errorKind ?? null).toBeNull();
    const cards = body(result).macro as Record<string, unknown>[];
    const metrics = cards.flatMap((card) => card.metrics as Record<string, unknown>[]);
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.every((metric) => metric.label === null && metric.text === null)).toBe(true);
  });
  it("research_context scopes positions and theses to the current portfolio", async () => {
    const s = await setup();
    holding(s, "NEW", "PLNEW0000011");
    const old = holding(s, "OLD", "PLOLD0000018", { thesis: "special_situation" });
    body(
      await s.server.call("add_research_note", {
        ...NOTE,
        instrument: "OLD",
        thesis_relation: "supports",
        polarity: "positive",
      }),
    );
    value(s.f, C.addManualTransaction, {
      account: s.account,
      instrument: old,
      type: "sell",
      tradeDate: "2026-01-05",
      quantity: "5",
      price: "100",
      cashAmount: "500",
      currency: "PLN",
    });
    const context = body(await s.server.call("research_context", {})),
      positions = context.positions as Record<string, unknown>[],
      watchlist = context.watchlist as Record<string, unknown>[];
    const fresh = positions.find((row) => row.symbol === "NEW");
    expect(fresh).toMatchObject({ thesis: null });
    expect(positions.map((row) => row.symbol)).not.toContain("OLD");
    expect(watchlist.map((row) => row.symbol)).not.toContain("OLD");
    const inUse = (context.strategy as Record<string, unknown>).entry_types_in_use as Record<
      string,
      unknown
    >[];
    expect(inUse.map((row) => row.entry_type)).toEqual(["trend"]);
  });
  it("research_context segments flag movers sold in the window and add positions bought in it", async () => {
    const s = await setup(),
      today = new Date(s.f.env.clock.now()).toISOString().slice(0, 10),
      daysAgo = (n: number) =>
        new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const trade = (instrument: string, type: "buy" | "sell", tradeDate: string) => {
      value(s.f, C.addManualTransaction, {
        account: s.account,
        type: "deposit",
        tradeDate,
        cashAmount: "500",
        currency: "PLN",
      });
      value(s.f, C.addManualTransaction, {
        account: s.account,
        instrument,
        type,
        tradeDate,
        quantity: "5",
        price: "100",
        cashAmount: type === "buy" ? "-500" : "500",
        currency: "PLN",
      });
    };
    const watched = (symbol: string, isin: string) =>
      value(s.f, C.addToWatchlist, {
        target: {
          planned: {
            symbol,
            isin,
            name: `Synthetic ${symbol}`,
            currency: "PLN",
            assetClass: "equity",
            mic: "XWAR",
          },
        },
      });
    const old = watched("OLD", "PLOLD0000018"),
      fresh = watched("NEW", "PLNEW0000011");
    trade(old.instrument, "buy", daysAgo(30));
    trade(old.instrument, "sell", daysAgo(2));
    trade(fresh.instrument, "buy", daysAgo(2));
    value(s.f, C.removeFromWatchlist, { item: old.item });
    value(s.f, C.removeFromWatchlist, { item: fresh.item });
    for (const instrument of [s.instrument, old.instrument, fresh.instrument])
      value(s.f, C.setInstrumentSegment, { instrument, segment: "equity_pl", by: "owner" });
    const context = body(await s.server.call("research_context", {})),
      positions = context.positions as Record<string, unknown>[],
      row = (context.segments as Record<string, unknown>[]).find((r) => r.segment === "equity_pl");
    const instruments = new Map(
      ((row?.instruments ?? []) as Record<string, unknown>[]).map((item) => [item.symbol, item]),
    );
    expect(instruments.get("OLD")).toMatchObject({ held: false, new_in_window: false });
    expect(instruments.get("ABC")).toMatchObject({ held: true, new_in_window: false });
    expect(instruments.get("NEW")).toMatchObject({
      held: true,
      new_in_window: true,
      contribution_1w: null,
    });
    const nowWeight = positions.reduce((sum, p) => sum + Number(p.weight ?? 0), 0);
    expect(row?.weight_now).toBeCloseTo(nowWeight, 5);
  });
  it("keeps genuine native macro summaries and rejects owner-data summaries under the unchanged vocabulary", async () => {
    const s = await setup(),
      context = body(await s.server.call("research_context", {})),
      cards = context.macro;
    expect(Array.isArray(cards)).toBe(true);
    if (!Array.isArray(cards)) throw new Error("missing cards");
    expect(cards).toHaveLength(5);
    expect(cards.every((card) => typeof card.summary === "string" && summaryOk(card.summary))).toBe(
      true,
    );
    s.maliciousMacro();
    const rejected = body(await s.server.call("research_context", {}));
    expect(
      Array.isArray(rejected.macro) && rejected.macro.every((card) => card.summary === null),
    ).toBe(true);
    expect(
      JSON.stringify(rejected, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain("Anna Nowak");
  });
  it("genuine authority loss defers only the optional plan pass, not the research-device note", async () => {
    const s = await setup();
    s.loseAuthority();
    const out = await s.server.call("add_research_note", { ...NOTE, instrument: "ABC" });
    expect(out.ok).toBe(true);
    expect(
      s.f.store
        .read<{ rule_id: string }>("SELECT rule_id FROM inv_signals")
        .filter((row) => row.rule_id.startsWith("plan:")),
    ).toHaveLength(0);
  });
  it("asks before saving forecast wording and saves it once the agent confirms", async () => {
    const s = await setup("strict", false);
    const forecast = { ...NOTE, instrument: "ABC", title: "Kurs wzrośnie do 50 zł po wynikach" };
    const first = await s.server.call("add_research_note", forecast);
    expect(first.ok).toBe(false);
    expect(first.error).toContain("not saved yet: title");
    expect(first.error).toContain("set_recommendations");
    expect(s.batches).toHaveLength(0);
    const second = await s.server.call("add_research_note", { ...forecast, wording_ok: true });
    expect(second.ok).toBe(true);
    expect(JSON.stringify(body(second).warnings)).toContain("title: saved as written");
    expect(s.batches[0]?.some((event) => event.type === "note.added")).toBe(true);
  });

  it("permits a valid base note and research signal without an optional plan provider", async () => {
    const s = await setup("strict", false);
    const out = await s.server.call("add_research_note", { ...NOTE, instrument: "ABC" });
    expect(out.ok).toBe(true);
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.some((event) => event.type === "note.added")).toBe(true);
    const signals = s.f.store.read<{ rule_id: string }>("SELECT rule_id FROM inv_signals");
    expect(signals.some((row) => row.rule_id.startsWith("research:"))).toBe(true);
    expect(signals.some((row) => row.rule_id.startsWith("plan:"))).toBe(false);
  });
});
it("groups exposure by weight with stable ties and hides an owned private asset's classification", () => {
  // the answer sends weights through pct(), which rounds to six places
  const rounded = (e: ReturnType<typeof research.researchExposure>) =>
    JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === "number" ? pct(v).value : v)));
  const exposure = research.researchExposure(
    [
      { assetClass: "equity", instrument: "a", region: "EU", sector: "energy", weight: 0.1 },
      { assetClass: "equity", instrument: "b", region: "US", sector: "industry", weight: 0.2 },
      { assetClass: "etf", instrument: "c", region: "EU", sector: "energy", weight: 0.3 },
      { assetClass: null, instrument: "d", region: null, sector: null, weight: null },
    ],
    new Set(),
  );
  expect(rounded(exposure)).toEqual({
    asset_classes: [
      { asset_class: "equity", weight: 0.3 },
      { asset_class: "etf", weight: 0.3 },
    ],
    regions: [
      { region: "EU", weight: 0.4 },
      { region: "US", weight: 0.2 },
    ],
    sectors: [
      { sector: "energy", weight: 0.4 },
      { sector: "industry", weight: 0.2 },
    ],
  });
  const owned = research.researchExposure(
    [
      { assetClass: "equity", instrument: "a", region: "EU", sector: "energy", weight: 0.5 },
      {
        assetClass: "property",
        instrument: "b",
        region: "Private place",
        sector: "Private industry",
        weight: 0.5,
      },
    ],
    new Set(["b"]),
  );
  expect(owned.regions).toEqual([
    { region: "EU", weight: 0.5 },
    { region: "unclassified", weight: 0.5 },
  ]);
  expect(owned.sectors).toEqual([
    { sector: "energy", weight: 0.5 },
    { sector: "unclassified", weight: 0.5 },
  ]);
});
