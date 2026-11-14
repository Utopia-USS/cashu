/** Actual parsed strategy -> store-backed portfolio -> engine -> lifecycle -> one event batch. */
import { addDays, D, parseDateTime } from "@cashu/domain";
import {
  asInstrumentId,
  asProfileId,
  buildSnapshot,
  InMemoryFxLookup,
  marketView,
  priceBar,
  valuePortfolio,
} from "@cashu/domain/investments";
import { buildRuleContext } from "@cashu/domain/investments/rules";
import { strategyStatus } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type CommandContext,
  type CommandResult,
  defineCommand,
  runCommand,
} from "../../command.js";
import { viewHash } from "../../snapshot.js";
import { shuffled } from "../../testing/random.js";
import { openTestStore } from "../../testing/store.js";
import { loadInstruments } from "../queries/instruments.js";
import { decisions } from "../queries/journal.js";
import { openSignals, ruleRuns, signalByGid } from "../queries/signals.js";
import { transactions } from "../queries/transactions.js";
import { noteByGid } from "../research/queries.js";
import { recordDecision } from "./journal.js";
import { addManualTransaction } from "./manual.js";
import { mergeInstruments } from "./merge.js";
import { type AppliedRuleSignals, applyRuleSignals, type RuleSignalPass } from "./ruleSignals.js";
import { applySignalActions, snoozeSignalCommand } from "./signals.js";
import {
  applyRaw,
  brokerage,
  otherVault,
  raw,
  rawGid,
  stock,
  type Vault,
  vault,
} from "./testing/fixtures.js";

const AT = "2026-10-31T12:00:00.123456Z";
const yaml = (severity = "info", maxWeight = "0.5", extra = "") =>
  `version: 1\nbase_currency: PLN\ndata: { max_unverified_days: 2, max_stale_weight: 1 }\nrules:\n  - { id: concentration, kind: position_concentration, severity: ${severity}, cooldown_days: 3, params: { max_weight: ${maxWeight} } }\n${extra}`;

function setup() {
  const v = vault();
  const account = brokerage(v);
  const member = stock(v, "AAA", "PL0000000AAA");
  applyRaw(v, [raw.watchAdded(v, member)]);
  v.value(addManualTransaction, {
    account,
    type: "deposit",
    tradeDate: "2026-10-30",
    cashAmount: "100",
  });
  v.value(addManualTransaction, {
    account,
    instrument: member,
    type: "buy",
    tradeDate: "2026-10-30",
    quantity: "10",
    price: "10",
  });
  return { v, account, member };
}

function contextBuilder(
  v: Vault,
  member: string,
  options: {
    stale?: boolean;
    rawIdentity?: string;
    foreignContext?: string;
    foreignSnapshot?: string;
  } = {},
): RuleSignalPass["buildContext"] {
  return (read, identities, config) => {
    const root = identities.instrument(member);
    if (root === undefined) throw new Error("missing synthetic instrument");
    // The loader's map key is the requested member, its Instrument.id is the canonical root.
    const loaded = loadInstruments(read, [member]);
    const instruments = new Map(
      [...loaded.values()].map((instrument) => [instrument.id, instrument]),
    );
    expect([...instruments.keys()]).toEqual([root]);
    const asOf = "2026-10-31";
    const bars = new Map([
      [
        root,
        [
          priceBar({
            instrumentId: root,
            date: options.stale ? addDays(asOf, -10) : asOf,
            close: D("10"),
            source: "synthetic",
          }),
        ],
      ],
    ]);
    const market = marketView({ asOf, instruments, bars });
    const txns = transactions(read).map((transaction) => {
      const account = identities.account(transaction.accountId);
      if (account === undefined) throw new Error("missing synthetic account");
      return { ...transaction, accountId: account };
    });
    let portfolio = valuePortfolio(
      buildSnapshot(asProfileId(v.store.vault), txns, asOf),
      market,
      new InMemoryFxLookup([]),
      config.baseCurrency,
      config.data.maxPriceAgeDays,
    );
    if (options.rawIdentity !== undefined) {
      const id = asInstrumentId(options.rawIdentity);
      portfolio = {
        ...portfolio,
        valued: portfolio.valued.map((holding) => ({
          ...holding,
          instrument: { ...holding.instrument, id },
          holding: { ...holding.holding, instrumentId: id },
        })),
      };
    }
    if (options.foreignSnapshot !== undefined) {
      portfolio = {
        ...portfolio,
        snapshot: { ...portfolio.snapshot, profileId: asProfileId(options.foreignSnapshot) },
      };
    }
    return buildRuleContext({
      profileId: asProfileId(options.foreignContext ?? v.store.vault),
      asOf,
      portfolio,
      market,
      data: config.data,
      contributions: config.contributions,
    });
  };
}

function execute(
  v: Vault,
  member: string,
  options: {
    yaml?: string | null;
    at?: string;
    stale?: boolean;
    rawIdentity?: string;
    foreignContext?: string;
    foreignSnapshot?: string;
    beforeApply?: (ctx: CommandContext) => void;
  } = {},
) {
  const strategy = strategyStatus(
    { yaml: options.yaml === undefined ? yaml() : options.yaml, md: null, readError: null },
    null,
  );
  let decided: CommandResult<AppliedRuleSignals> | undefined;
  let batches = 0;
  let builds = 0;
  const cmd = defineCommand({
    id: "test.ruleSignalPass",
    input: z.object({}),
    run(ctx) {
      options.beforeApply?.(ctx);
      const run = ctx.newGid();
      const at = parseDateTime(options.at ?? AT);
      decided = applyRuleSignals(ctx, {
        strategy,
        run,
        at,
        buildContext: (read, identities, config) => {
          builds += 1;
          return contextBuilder(v, member, options)(read, identities, config);
        },
      });
      if (decided.ok) {
        ctx.emit("ruleRun.finished", run, {
          ...raw.ruleRun(run).data,
          stats: decided.value.reconciliation.stats,
          report: {
            new: decided.value.applied.created,
            escalated: decided.value.applied.escalated,
          },
        });
      }
      return decided;
    },
  });
  const out = runCommand(
    v.store,
    {
      append(events) {
        batches += 1;
        // This is inspected BEFORE folding, so episode aliasing cannot hide a wrong create/resolve.
        expect(decided?.ok).toBe(true);
        v.store.applyEnvelopes(events);
      },
    },
    cmd,
    {},
    v.env,
  );
  return { out, batches, builds };
}

function value(result: ReturnType<typeof execute>) {
  if (!result.out.ok) throw new Error(result.out.reason);
  expect(result.batches).toBe(1);
  return result.out.value;
}

describe("same-context strategy signal pass", () => {
  it("creates, refreshes, acknowledges, reactivates on escalation, preserves snooze notification policy", () => {
    const { v, member } = setup();
    const first = value(execute(v, member));
    const signal = first.applied.created[0] as string;
    expect(first.reconciliation.stats.signals_new).toBe(1);
    expect(first.applied.notify).toEqual([]);
    const emitted = execute(v, member);
    expect(emitted.out.ok && emitted.out.events.map((event) => event.type)).toEqual([
      "signal.refreshed",
      "ruleRun.finished",
    ]);
    if (!emitted.out.ok) throw new Error(emitted.out.reason);
    const finished = emitted.out.events[1];
    expect(signalByGid(v.store.read.bind(v.store), signal)?.lastRun).toBe(finished?.gid);
    expect(finished?.data.stats).toMatchObject({
      signals_new: 0,
      signals_refreshed: 1,
      signals_suppressed: 0,
    });
    expect(value(execute(v, member)).applied.refreshed).toEqual([signal]);
    v.value(recordDecision, { action: "held", signals: [signal] });
    v.value(snoozeSignalCommand, { signal, until: "2026-11-02T12:00:00Z" });
    const escalated = value(execute(v, member, { yaml: yaml("action") }));
    expect(escalated.applied.escalated).toEqual([signal]);
    expect(escalated.applied.notify).toEqual([]);
    expect(signalByGid(v.store.read.bind(v.store), signal)).toMatchObject({
      status: "active",
      severity: "action",
      acknowledgedAt: null,
      lastSeenAt: "2026-10-31 12:00:00.123456",
    });
  });

  it("ages only untouched signals strictly after the limit; age expiry starts no cooldown", () => {
    const { v, member } = setup();
    const signal = value(execute(v, member)).applied.created[0] as string;
    const skipped = value(execute(v, member, { stale: true, at: "2026-11-02T12:00:00.123456Z" }));
    expect(skipped.outcomes[0]?.type).toBe("skipped");
    expect(skipped.reconciliation.untouched).toHaveLength(1);
    const priorRun = signalByGid(v.store.read.bind(v.store), signal)?.lastRun;
    const expired = value(execute(v, member, { stale: true, at: "2026-11-02T12:00:00.123457Z" }));
    expect(expired.applied.expired).toEqual([signal]);
    expect(signalByGid(v.store.read.bind(v.store), signal)).toMatchObject({
      lastRun: priorRun,
      payload: { closed_by: "unverified", closed_reason: "unverified" },
    });
    expect(
      value(execute(v, member, { at: "2026-11-02T12:00:00.123458Z" })).applied.created,
    ).toHaveLength(1);
  });

  it("resolves confirmed scopes and suppresses until cooldown equality, then creates a fresh episode", () => {
    const { v, member } = setup();
    const first = value(execute(v, member)).applied.created[0] as string;
    expect(
      value(execute(v, member, { yaml: yaml("info", "1"), at: "2026-11-01T12:00:00.123456Z" }))
        .applied.resolved,
    ).toEqual([first]);
    const suppressed = value(execute(v, member, { at: "2026-11-04T12:00:00.123455Z" }));
    expect(suppressed.reconciliation.stats.signals_suppressed).toBe(1);
    expect(suppressed.applied.created).toEqual([]);
    const fresh = value(execute(v, member, { at: "2026-11-04T12:00:00.123456Z" })).applied
      .created[0];
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(first);
  });

  it("keeps inactive/invalid strategy signals known and excludes other signal owners", () => {
    const { v, member } = setup();
    const signal = value(execute(v, member)).applied.created[0] as string;
    applyRaw(v, [
      raw.signalOpened(rawGid(51), `plan:no_thesis|i:${member}`, { instrument: member }),
      raw.signalOpened(rawGid(52), `research:2026-W44|i:${member}`, { instrument: member }),
    ]);
    const partial = value(
      execute(v, member, {
        yaml: "version: 1\nbase_currency: PLN\nrules:\n  - { id: concentration, kind: unknown_kind }\n",
      }),
    );
    expect(partial.reconciliation.untouched.map((signal) => signal.signalId)).toEqual([signal]);
    const invalidPass = execute(v, member, { yaml: "[" });
    expect(invalidPass.builds).toBe(0);
    const invalid = value(invalidPass);
    expect(invalid.reconciliation.untouched).toHaveLength(1);
    expect(
      value(execute(v, member, { yaml: "version: 1\nbase_currency: PLN\nrules: []\n" })).applied
        .expired,
    ).toEqual([signal]);
    expect(openSignals(v.store.read.bind(v.store))).toHaveLength(2);
  });

  it("normalizes member inputs to roots and refreshes before folding after an instrument merge", () => {
    const { v, member } = setup();
    const signal = value(execute(v, member)).applied.created[0] as string;
    const target = stock(v, "BBB", "PL0000000BBB", {
      isin: null,
      aliases: [{ namespace: "synthetic", value: "target" }],
    });
    const alias = rawGid(61);
    applyRaw(v, [
      raw.signalOpened(alias, `concentration|i:${target}`, {
        ruleId: "concentration",
        instrument: target,
      }),
    ]);
    v.value(mergeInstruments, { source: member, target });
    const refreshed = value(execute(v, member));
    expect(refreshed.reconciliation.created).toEqual([]);
    expect(refreshed.reconciliation.resolved).toEqual([]);
    expect(refreshed.reconciliation.refreshed).toHaveLength(1);
    expect(refreshed.outcomes[0]?.dedupKey).toBe(`concentration|i:${target}`);
    const read = v.store.read.bind(v.store);
    expect(signalByGid(read, signal)?.gid).toBe(signalByGid(read, alias)?.gid);
    expect(openSignals(read)).toHaveLength(1);
    const note = rawGid(62);
    applyRaw(v, [raw.noteAdded(note, target, { signal: alias })]);
    expect(noteByGid(read, note)?.signal).toBe(signalByGid(read, signal)?.gid);
    const reported = ruleRuns(read).flatMap((run) => run.report.new as string[]);
    expect(reported).toContain(signal);
    expect(reported.map((gid) => signalByGid(read, gid)?.gid)).toContain(
      signalByGid(read, alias)?.gid,
    );
    v.value(recordDecision, { action: "held", signals: [alias] });
    expect(decisions(read, { signal })).toHaveLength(1);
    expect(signalByGid(read, signal)?.status).toBe("acknowledged");
    v.value(applySignalActions, {
      run: null,
      actions: [{ type: "resolve", signal: alias, resolvedAt: AT }],
    });
    expect(signalByGid(read, signal)?.status).toBe("resolved");
    const fresh = value(execute(v, member, { at: "2026-11-03T12:00:00.123456Z" })).applied
      .created[0];
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(signalByGid(read, alias)?.gid);
    const expected = viewHash(v.store).hash;
    const events = v.store.foreignEvents(0, new Set(), 1000).events;
    for (const seed of [1, 7, 19]) {
      const copy = openTestStore();
      for (const event of shuffled(events, seed)) {
        const result = copy.applyEnvelopes([event, event]);
        expect(result.rejected).toEqual([]);
      }
      expect(viewHash(copy).hash).toBe(expected);
      expect(signalByGid(copy.read.bind(copy), alias)?.gid).toBe(
        signalByGid(copy.read.bind(copy), signal)?.gid,
      );
      copy.rebuild();
      expect(viewHash(copy).hash).toBe(expected);
      copy.close();
    }
  });

  it("resolves account member identities and folds account-key signal episodes to the root", () => {
    const { v, account, member } = setup();
    const target = brokerage(v, "Synthetic target");
    const first = rawGid(71);
    const second = rawGid(72);
    applyRaw(v, [
      raw.signalOpened(first, `plan:account|a:${account}`, { account }),
      raw.signalOpened(second, `plan:account|a:${target}`, { account: target }),
      { type: "account.identified", gid: target, data: { keys: ["ext:xtb:synthetic-joined"] } },
      { type: "account.identified", gid: account, data: { keys: ["ext:xtb:synthetic-joined"] } },
    ]);
    const read = v.store.read.bind(v.store);
    expect(signalByGid(read, first)?.gid).toBe(signalByGid(read, second)?.gid);
    expect(signalByGid(read, first)?.dedupKey).toBe(`plan:account|a:${target}`);
    // The real context builder resolves transaction accounts using the helper's identities API.
    expect(value(execute(v, member)).applied.created).toHaveLength(1);
  });

  it("refuses nonleaders before any context read/build or append", () => {
    const { v, member } = setup();
    v.env.holder = false;
    const result = execute(v, member);
    expect(result.out).toEqual({ ok: false, reason: "not_leader" });
    expect(result.batches).toBe(0);
    expect(result.builds).toBe(0);
  });

  it("rejects foreign, numeric and non-root keyed fired/not-fired/skipped scopes before reconciliation", () => {
    const { v, member } = setup();
    const other = otherVault();
    const foreign = stock(other, "FOREIGN", "PL00000FRGN0");
    const target = stock(v, "BBB", "PL0000000BBB", {
      isin: null,
      aliases: [{ namespace: "synthetic", value: "target" }],
    });
    v.value(mergeInstruments, { source: member, target });
    for (const rawIdentity of [member, foreign, "17"]) {
      for (const options of [{}, { yaml: yaml("info", "1") }, { stale: true }]) {
        const result = execute(v, member, { ...options, rawIdentity });
        expect(result.out).toEqual({ ok: false, reason: "invalid_identity" });
        expect(result.batches).toBe(0);
      }
    }
    expect(openSignals(other.store.read.bind(other.store))).toEqual([]);
    expect(openSignals(v.store.read.bind(v.store))).toEqual([]);
  });

  it("rejects a foreign context or snapshot even when a global rule emits no entity references", () => {
    const { v, member } = setup();
    const other = otherVault();
    const global =
      "version: 1\nbase_currency: PLN\nrules:\n  - { id: cash, kind: cash_level, params: { min_weight: 0.1 } }\n";
    for (const mismatch of [
      { foreignContext: other.store.vault },
      { foreignSnapshot: other.store.vault },
    ]) {
      const result = execute(v, member, { yaml: global, ...mismatch });
      expect(result.out).toEqual({ ok: false, reason: "invalid_identity" });
      expect(result.batches).toBe(0);
    }
    expect(openSignals(v.store.read.bind(v.store))).toEqual([]);
    expect(openSignals(other.store.read.bind(other.store))).toEqual([]);
  });
});
