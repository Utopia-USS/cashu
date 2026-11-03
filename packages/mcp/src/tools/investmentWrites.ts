/** Native local investment writes. Remote lookup and import publication remain separate capabilities. */

import { pyLen, pyStrip, tryCurrency } from "@cashu/domain";
import { PLAN_VALUES } from "@cashu/domain/investments";
import { exchangeForHint } from "@cashu/domain/investments/importing";
import { strategyDigest } from "@cashu/domain/investments/strategy";
import { investmentsCommands as C, investmentsResearch as R } from "@cashu/store";
import * as Q from "@cashu/store/investments/queries";
import {
  addStoredWatchWithPlans,
  createInvestmentProposal,
  prepareRuleCreation,
  prepareStrategyCreation,
  recommendWithPlans,
  removeWatchWithPlans,
  renderProposalRule,
  StrategyProposalError,
  upsertThesisWithPlans,
} from "@cashu/store/investments/services";
import * as L from "../privacy/labels.js";
import { systemText } from "../privacy/messages.js";
import type { InvestmentWriteServices } from "../providers/investmentWriteTypes.js";
import { type ToolArgs, ToolError, type ToolSpec } from "../registry.js";
import { DELEGATED_TOOLS } from "../runtime/delegated.generated.js";
import type { NativeToolStore } from "../runtime/types.js";
import { addAlert, alerts, instrumentFields, muteAlert, price } from "./alerts.js";
import { hintParams } from "./investmentsRead.js";
import {
  type Context,
  currentStrategyFiles as currentFiles,
  execute,
  instrument,
  reference,
} from "./investmentWriteSupport.js";
import * as F from "./researchLabels.js";

const services = (ctx: Context) => {
  const service = ctx.store.investmentWrites;
  if (!service)
    throw new ToolError("native investment market context is unavailable", "unsupported");
  return service;
};
function recommend(ctx: Context, args: ToolArgs): L.LabelledTree {
  const id = instrument(ctx, args.instrument);
  if (
    (args.recommendation === "reduce" || args.recommendation === "exit_asap") &&
    !Q.heldSince(ctx.store.read, ctx.today).has(id)
  )
    throw new ToolError(`Plan '${args.recommendation}' needs a held instrument`);
  const result = execute(ctx, recommendWithPlans(ctx.store.investmentWrites?.plans), {
    today: ctx.today,
    scope: null,
    updates: [{ instrument: id, plan: args.recommendation, reason: args.reason }],
  });
  const row = result.saved[0];
  if (!row) throw new Error("recommendation was not prepared");
  return {
    instrument_id: F.ref("instrument", id),
    recommendation: L.category(row.plan),
    generated_at: F.date(row.generatedAt),
    reason_saved: L.flag(row.reasonSaved),
    note: L.fixedText("model recommendation saved; no decision or transaction was recorded"),
  };
}
function recommendations(ctx: Context, args: ToolArgs): L.LabelledTree {
  const updates = F.array(args.recommendations);
  if (updates.length > 250)
    throw new ToolError("too many recommendation updates (max 250)", "invalid_arguments");
  const held = Q.heldSince(ctx.store.read, ctx.today),
    watched = Q.watchedInstrumentGids(ctx.store.read);
  const selected =
    args.scope === "held"
      ? new Set(held.keys())
      : args.scope === "watchlist"
        ? watched
        : new Set([...held.keys(), ...watched]);
  const loaded = Q.loadInstruments(ctx.store.read, selected);
  const expected = new Set(
    [...loaded].filter(([, inst]) => R.researchable(inst)).map(([id]) => id),
  );
  const seen = new Set<string>();
  const parsed = updates.map((raw, index) => {
    const row = F.object(raw);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new ToolError(`recommendations[${index}] must be an object`, "invalid_arguments");
    if (Object.keys(row).some((k) => !["instrument", "recommendation", "reason"].includes(k)))
      throw new ToolError(
        `recommendations[${index}] has unknown fields; allowed: instrument, recommendation, reason`,
        "invalid_arguments",
      );
    if (
      typeof row.instrument !== "string" ||
      !pyStrip(row.instrument) ||
      (!row.instrument.startsWith("instrument:") && [...row.instrument].length > 40)
    )
      throw new ToolError(
        `recommendations[${index}].instrument must be a non-empty string (max 40)`,
        "invalid_arguments",
      );
    if (!(PLAN_VALUES as readonly unknown[]).includes(row.recommendation))
      throw new ToolError(
        `recommendations[${index}].recommendation must be one of: ${PLAN_VALUES.join(", ")}`,
        "invalid_arguments",
      );
    if (typeof row.reason !== "string" || !pyStrip(row.reason) || pyLen(row.reason) > 280)
      throw new ToolError(
        `recommendations[${index}].reason must be a non-empty string (max 280)`,
        "invalid_arguments",
        { system: true },
      );
    const id = instrument(ctx, row.instrument);
    if (!expected.has(id))
      throw new ToolError(
        `recommendations[${index}] is outside the selected ${args.scope} scope`,
        "invalid_arguments",
      );
    if (seen.has(id))
      throw new ToolError(
        `recommendations[${index}] duplicates an instrument`,
        "invalid_arguments",
      );
    seen.add(id);
    return {
      instrument: id,
      plan: row.recommendation,
      reason: row.reason,
    };
  });
  const missing = [...expected].filter(
    (id) => loaded.get(id)?.plan == null && !seen.has(id),
  ).length;
  if (missing)
    throw new ToolError(
      `recommendation coverage incomplete: expected ${expected.size}, covered ${expected.size - missing}, missing ${missing}; see research_context for rows with recommendation null`,
      "incomplete_coverage",
    );
  for (const update of parsed)
    if ((update.plan === "reduce" || update.plan === "exit_asap") && !held.has(update.instrument))
      throw new ToolError(`Plan '${update.plan}' needs a held instrument`);
  const out = execute(ctx, recommendWithPlans(ctx.store.investmentWrites?.plans), {
    today: ctx.today,
    scope: args.scope,
    updates: parsed,
  });
  return {
    scope: F.category(args.scope),
    expected: L.count(out.expected),
    covered: L.count(out.expected),
    missing: L.count(0),
    updated: L.count(out.updated),
    note: L.fixedText(
      "complete model recommendation coverage saved; no decision or transaction was recorded",
    ),
  };
}
function decision(ctx: Context, args: ToolArgs): L.LabelledTree {
  const id = reference("signal", args.signal_id),
    signal = Q.signalByGid(ctx.store.read, id);
  if (!signal) throw new ToolError("no such signal in this profile (see signals)", "not_found");
  const out = execute(ctx, C.recordDecision, {
    signals: [id],
    action: args.action,
    reason: args.reason ?? null,
  });
  return {
    decision_id: F.ref("decision", out.decision),
    signal_id: F.ref("signal", signal.gid),
    action: F.category(args.action),
    signal_status: L.category(signal.status === "active" ? "acknowledged" : signal.status),
    note: L.fixedText("recorded in the decision journal; no transaction was booked"),
  };
}
function thesis(ctx: Context, args: ToolArgs): L.LabelledTree {
  const id = instrument(ctx, args.instrument),
    values: Record<string, unknown> = { entryType: args.entry_type, thesis: args.thesis };
  for (const [from, to] of [
    ["invalidation", "invalidation"],
    ["exit_plan", "exitPlan"],
    ["size_plan", "sizePlan"],
  ])
    if (from && to && args[from] != null) values[to] = args[from];
  const out = execute(ctx, upsertThesisWithPlans(ctx.store.investmentWrites?.plans), {
    instrument: id,
    values,
  });
  return {
    thesis_id: F.ref("thesis", out.thesis),
    instrument_id: F.ref("instrument", out.instrument),
    created: L.flag(out.created),
    entry_type: L.category(out.entryType),
  };
}
function watchRow(
  ctx: Context,
  row: ReturnType<InvestmentWriteServices["watchlist"]>[number],
): L.LabelledTree {
  const inst = Q.loadInstrument(ctx.store.read, row.instrument_id),
    privateName = inst !== undefined && R.ownerNamed(inst),
    p = row.price,
    nearest = row.alerts.nearest,
    fresh = row.instrument?.plan_freshness;
  return {
    item_id: F.ref("watchlist", row.id),
    instrument: instrumentFields(ctx, row.instrument_id),
    note: L.text(row.note),
    tags: row.tags.map(L.category),
    source: L.category(row.source),
    added_at: F.date(row.added_at),
    held: L.flag(row.held),
    recommendation: L.category(row.instrument?.plan ?? null),
    plan_freshness:
      fresh == null
        ? null
        : {
            state: L.category(fresh.state),
            reasons: [...new Set(fresh.reasons.map((r) => r.code))].map(L.category),
          },
    hints: row.hints.map((h) => ({
      code: L.category(h.code),
      severity: L.category(h.severity),
      params: hintParams(h.params),
    })),
    price_source: L.flag(row.price_source),
    last_close: price(p?.close ?? null, privateName),
    price_date: F.date(p?.date ?? null),
    stale: p === null ? L.flag(null) : L.flag(p.stale),
    change_1d: L.pct(p?.change_1d ?? null),
    change_1m: L.pct(p?.change_1m ?? null),
    high_52w: price(p?.high_52w ?? null, privateName),
    from_high_52w: L.pct(p?.from_high_52w ?? null),
    alerts: {
      count: L.count(row.alerts.count),
      live: L.count(row.alerts.live),
      triggered: L.count(row.alerts.triggered),
      nearest:
        nearest === null
          ? null
          : {
              alert_id: F.ref("alert", nearest.alert_id),
              kind: L.category(nearest.kind),
              level: price(nearest.level, privateName),
              distance_pct: L.pct(nearest.distance_pct),
            },
    },
  };
}
function watchlist(ctx: Context): L.LabelledTree {
  return {
    items: services(ctx)
      .watchlist()
      .map((row) => watchRow(ctx, row)),
    note: L.fixedText(
      "watched instruments join the daily price refresh; changes and distances are fractions (0.05 = 5%) from stored closes, never forecasts",
    ),
  };
}
function addWatch(ctx: Context, args: ToolArgs): L.LabelledTree {
  // Deliberately bounded local path. The full source resolver can await public search/chart work.
  if (typeof args.note === "string") {
    const checked = C.cleanNote(args.note);
    if (!checked.ok) throw new ToolError("note is too long (max 1000 characters)");
  }
  if (Q.watchlist(ctx.store.read).length >= C.MAX_ITEMS)
    throw new ToolError("watchlist is full (max 200)");
  const raw = typeof args.symbol_or_isin === "string" ? args.symbol_or_isin : "";
  const explicit =
    /^(?:instrument|signal|thesis|alert|watchlist|account|decision|proposal|run|note|review|loan):/u.test(
      raw,
    );
  if (!explicit && [...raw].length > 40)
    throw new ToolError("argument symbol_or_isin is too long (max 40)", "invalid_arguments", {
      system: true,
    });
  if (!explicit && !/^[A-Za-z0-9][A-Za-z0-9.:\-_^=]{0,39}$/u.test(raw))
    throw new ToolError(
      "symbol_or_isin must be a ticker or an ISIN (letters, digits and . : - _ ^ =, up to 40)",
    );
  if (
    typeof args.currency === "string" &&
    args.currency.trim() &&
    tryCurrency(args.currency.trim().toUpperCase()) === null
  )
    throw new ToolError("currency must be a 3-letter currency code (e.g. EUR)");
  if (
    typeof args.exchange === "string" &&
    args.exchange.trim() &&
    exchangeForHint(args.exchange) === null
  )
    throw new ToolError("unknown exchange");
  let id: string;
  try {
    id = instrument(ctx, args.symbol_or_isin, true);
  } catch (error) {
    if (!(error instanceof ToolError) || error.kind !== "not_found" || explicit) throw error;
    throw new ToolError(
      "native remote watchlist resolution is unavailable; use an existing instrument reference",
      "unsupported",
    );
  }
  const service = services(ctx);
  const out = execute(ctx, addStoredWatchWithPlans(service.plans), {
    instrument: id,
    note: args.note,
  });
  const row = service.watchlist(out).find((r) => r.id === out.item);
  if (!row) throw new Error("prospective watch item missing");
  return {
    item: watchRow(ctx, row),
    created_instrument: L.flag(false),
    restored: L.flag(out.restored),
    warnings: [],
  };
}
function removeWatch(ctx: Context, args: ToolArgs): L.LabelledTree {
  const id = reference("watchlist", args.id);
  const out = execute(ctx, removeWatchWithPlans(ctx.store.investmentWrites?.plans), { item: id });
  return { item_id: F.ref("watchlist", out.item), removed: L.flag(true) };
}
const issue = (
  ctx: Context,
  i: {
    severity: string;
    path: string;
    message: string;
    line: number | null;
    column: number | null;
  },
) => ({
  severity: L.category(i.severity),
  path: L.text(i.path),
  message: systemText(ctx, i.message),
  line: L.count(i.line),
  column: L.count(i.column),
});
function strategy(ctx: Context, args: ToolArgs): L.LabelledTree {
  if (typeof args.yaml !== "string" || !pyStrip(args.yaml)) throw new ToolError("yaml is empty");
  const { files, base } = currentFiles(ctx),
    yaml = String(args.yaml),
    md = typeof args.md === "string" ? args.md : null,
    dry = args.dry_run === true;
  const prepared = prepareStrategyCreation(base, yaml, md),
    config = prepared.result.config ?? prepared.result.partial;
  const result: Record<string, L.LabelledTree> = {
    valid: L.flag(!prepared.error),
    state: L.category(
      prepared.result.config ? "valid" : prepared.result.partial ? "partial" : "invalid",
    ),
    issues: prepared.result.issues.map((i) => ({ ...issue(ctx, i), code: L.category(i.code) })),
    warnings: prepared.warnings.map((w) => ({ code: L.category(w.code), rule: L.text(w.rule_id) })),
    yaml_diff: {
      lines_added: L.count(prepared.yamlDiff.lines_added),
      lines_removed: L.count(prepared.yamlDiff.lines_removed),
    },
    md_diff:
      prepared.mdDiff === null
        ? null
        : {
            lines_added: L.count(prepared.mdDiff.lines_added),
            lines_removed: L.count(prepared.mdDiff.lines_removed),
          },
    stored: L.flag(false),
    dry_run: L.flag(dry),
  };
  if (config) {
    result.rules = L.count(config.rules.length);
    result.buckets = config.allocation.buckets.map((b) => L.category(b.id));
  }
  if (prepared.error) {
    result.error_code = L.category(prepared.error.code);
    result.note = L.fixedText("not stored: fix the errors (line / column above) and propose again");
    return result;
  }
  if (dry) return result;
  const out = execute(ctx, createInvestmentProposal(files, base), {
    kind: "strategy",
    summary: `Strategy: ${config?.rules.length ?? 0} rules, ${config?.allocation.buckets.length ?? 0} buckets`,
    reason: args.reason ?? null,
    payload: {
      yaml,
      md,
      base_sha256: strategyDigest(base.yaml ?? "", base.md),
      issues: prepared.result.issues.map(({ severity, path, message, line, column }) => ({
        severity,
        path,
        message,
        line,
        column,
      })),
    },
  });
  return {
    ...result,
    stored: L.flag(true),
    proposal_id: F.ref("proposal", out.proposalGid),
    note: L.fixedText("stored as a proposal; the owner approves it in the app (Inwestycje)"),
  };
}
function rule(ctx: Context, args: ToolArgs): L.LabelledTree {
  const { service, files, base } = currentFiles(ctx),
    dry = args.dry_run === true,
    prepared = prepareRuleCreation(base, String(args.kind_or_expression), F.object(args.params));
  const valid = prepared.result !== null && !prepared.own.some((i) => i.severity === "error");
  const result: Record<string, L.LabelledTree> = {
    rule_id: F.text(prepared.entry.id),
    kind: F.category(prepared.entry.kind),
    scope: F.category(F.object(prepared.entry.params).scope),
    valid: L.flag(valid),
    issues: prepared.own.map((i) => issue(ctx, i)),
    stored: L.flag(false),
    dry_run: L.flag(dry),
  };
  if (!valid) {
    return { ...result, note: L.fixedText("not stored: fix the errors and propose again") };
  }
  if (!prepared.spec || !prepared.config)
    return {
      ...result,
      valid: L.flag(false),
      note: L.fixedText("not stored: the rule did not load"),
    };
  const backtest = service.backtest(prepared.spec, prepared.config),
    labelled: Record<string, L.LabelledTree> = {};
  for (const [key, value] of Object.entries(backtest))
    labelled[key] = ["from", "to", "first_fired", "last_fired"].includes(key)
      ? F.date(value)
      : key === "fired_dates"
        ? F.array(value).map(F.date)
        : key === "instruments"
          ? F.array(value).map(F.symbol)
          : key === "skip_reasons"
            ? F.array(value).map(F.text)
            : key === "note"
              ? F.text(value)
              : F.count(value);
  result.backtest = labelled;
  if (dry) return result;
  const out = execute(ctx, createInvestmentProposal(files, base), {
    kind: "custom_rule",
    reason: args.reason ?? null,
    summary: `Rule ${prepared.entry.id} (${prepared.entry.kind}): fired ${"episodes" in backtest ? backtest.episodes : 0}x in backtest`,
    payload: {
      rule: prepared.entry,
      rule_yaml: renderProposalRule(prepared.entry),
      base_sha256: strategyDigest(base.yaml ?? "", base.md),
      backtest,
    },
  });
  return {
    ...result,
    stored: L.flag(true),
    proposal_id: F.ref("proposal", out.proposalGid),
    note: L.fixedText("stored as a proposal; the owner approves it in the app (Inwestycje)"),
  };
}
const HANDLERS: Readonly<Record<string, ToolSpec<NativeToolStore>["handler"]>> = {
  set_recommendation: recommend,
  set_recommendations: recommendations,
  record_decision: decision,
  upsert_thesis: thesis,
  alerts,
  add_alert: addAlert,
  mute_alert: muteAlert,
  watchlist,
  add_to_watchlist: addWatch,
  remove_from_watchlist: removeWatch,
  propose_strategy: strategy,
  propose_custom_rule: rule,
};
/** Native references intentionally differ from Python's local integer input IDs. Frozen metadata stays untouched. */
export function investmentWriteTools(): readonly ToolSpec<NativeToolStore>[] {
  return DELEGATED_TOOLS.flatMap((metadata) => {
    const handler = HANDLERS[metadata.name];
    if (!handler) return [];
    const properties = { ...metadata.properties };
    if (metadata.name === "set_recommendations") {
      const items = F.object(properties.recommendations?.items);
      const fields = F.object(items.properties);
      properties.recommendations = {
        ...properties.recommendations,
        items: {
          ...items,
          properties: { ...fields, instrument: { ...F.object(fields.instrument), maxLength: 64 } },
        },
      };
    }
    for (const name of ["instrument", "symbol_or_isin"])
      if (properties[name]?.type === "string")
        properties[name] = { ...properties[name], maxLength: 64 };
    const key =
      metadata.name === "record_decision"
        ? "signal_id"
        : ["mute_alert", "remove_from_watchlist"].includes(metadata.name)
          ? "id"
          : null;
    if (key)
      properties[key] = {
        type: "string",
        maxLength: 64,
        description: "opaque reference returned by this profile's native tools",
      };
    return [
      {
        ...metadata,
        properties,
        handler: (ctx: Context, args: ToolArgs) => {
          try {
            return handler(ctx, args);
          } catch (e) {
            if (e instanceof StrategyProposalError) throw new ToolError(e.message, e.code);
            throw e;
          }
        },
      },
    ];
  });
}
