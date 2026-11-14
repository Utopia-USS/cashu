/** Native investment contracts; the async runtime owns awaited lookup and checked publication. */

import { pyLen, pyStrip, tryCurrency } from "@cashu/domain";
import {
  type Instrument,
  isPositionStrength,
  isStrengthBasis,
  PLAN_VALUES,
  POSITION_STRENGTHS,
  type PositionStrength,
  planVsStrength,
  STRENGTH_BASES,
  type StrengthBasis,
  strengthAllowed,
} from "@cashu/domain/investments";
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
import { type ToolArgs, type ToolContext, ToolError, type ToolSpec } from "../registry.js";
import { NATIVE_TOOL_SCHEMAS } from "../runtime/toolSchemas.js";
import type { NativeToolStore } from "../runtime/types.js";
import { addAlert, alerts, instrumentFields, muteAlert, price } from "./alerts.js";
import { proposeInvestmentImport } from "./investmentImportProposal.js";
import { searchInstruments } from "./investmentSearch.js";
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
/** Rules 2-3 of a model assessment row: the basis fits the strength, the recommendation agrees. */
function checkAssessment(
  where: string,
  strength: PositionStrength,
  basis: StrengthBasis,
  plan: string | null,
): void {
  if (!strengthAllowed(strength, basis))
    throw new ToolError(
      basis === "fulfilled"
        ? `${where}strength_basis 'fulfilled' needs strength weak`
        : `${where}strength_basis 'on_track' cannot go with strength weak`,
      "invalid_arguments",
    );
  if (!planVsStrength(plan, strength))
    throw new ToolError(
      `${where}recommendation '${plan}' contradicts strength '${strength}' (buy / buy_asap never with weak, reduce / exit_asap never with strong)`,
      "invalid_arguments",
    );
}
async function recommend(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const id = instrument(ctx, args.instrument);
  if (!isPositionStrength(args.strength) || !isStrengthBasis(args.strength_basis))
    throw new ToolError("strength and strength_basis are required", "invalid_arguments");
  if (typeof args.reason !== "string" || !pyStrip(args.reason))
    throw new ToolError("reason must be a non-empty string (max 280)", "invalid_arguments");
  const plan = typeof args.recommendation === "string" ? args.recommendation : null;
  if (
    (plan === "reduce" || plan === "exit_asap") &&
    !Q.heldSince(ctx.store.read, ctx.today).has(id)
  )
    throw new ToolError(`Plan '${plan}' needs a held instrument`);
  checkAssessment("", args.strength, args.strength_basis, plan);
  const result = await execute(ctx, recommendWithPlans(ctx.store.investmentWrites?.plans), {
    today: ctx.today,
    scope: null,
    updates: [
      {
        instrument: id,
        strength: args.strength,
        basis: args.strength_basis,
        ...(plan === null ? {} : { plan }),
        reason: args.reason,
      },
    ],
  });
  const row = result.saved[0];
  if (!row) throw new Error("recommendation was not prepared");
  return {
    instrument_id: F.ref("instrument", id),
    strength: L.category(row.strength),
    strength_basis: L.category(row.basis),
    recommendation: L.category(row.plan),
    generated_at: F.date(row.generatedAt),
    reason_saved: L.flag(row.reasonSaved),
    note: L.fixedText(
      row.plan === null
        ? "model assessment saved (no recommendation; an older one was cleared); no decision or transaction was recorded"
        : "model assessment and recommendation saved; no decision or transaction was recorded",
    ),
  };
}
const ROW_KEYS = ["instrument", "strength", "strength_basis", "recommendation", "reason"];
async function recommendations(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
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
    if (Object.keys(row).some((k) => !ROW_KEYS.includes(k)))
      throw new ToolError(
        `recommendations[${index}] has unknown fields; allowed: ${ROW_KEYS.join(", ")}`,
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
    if (!isPositionStrength(row.strength))
      throw new ToolError(
        `recommendations[${index}].strength is required, one of: ${POSITION_STRENGTHS.join(", ")}`,
        "invalid_arguments",
      );
    if (!isStrengthBasis(row.strength_basis))
      throw new ToolError(
        `recommendations[${index}].strength_basis is required, one of: ${STRENGTH_BASES.join(", ")}`,
        "invalid_arguments",
      );
    const plan = row.recommendation ?? null;
    if (plan !== null && !(PLAN_VALUES as readonly unknown[]).includes(plan))
      throw new ToolError(
        `recommendations[${index}].recommendation must be one of: ${PLAN_VALUES.join(", ")} (or omitted)`,
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
      strength: row.strength,
      basis: row.strength_basis,
      plan: plan as string | null,
      reason: row.reason,
    };
  });
  // Coverage counts the strength: a stored recommendation without a strength is missing.
  const missing = [...expected].filter(
    (id) => loaded.get(id)?.positionStrength == null && !seen.has(id),
  ).length;
  if (missing)
    throw new ToolError(
      `strength coverage incomplete: expected ${expected.size}, covered ${expected.size - missing}, missing ${missing}; see research_context for rows with strength null`,
      "incomplete_coverage",
    );
  parsed.forEach((update, index) => {
    if ((update.plan === "reduce" || update.plan === "exit_asap") && !held.has(update.instrument))
      throw new ToolError(`Plan '${update.plan}' needs a held instrument`);
    checkAssessment(`recommendations[${index}].`, update.strength, update.basis, update.plan);
  });
  const out = await execute(ctx, recommendWithPlans(ctx.store.investmentWrites?.plans), {
    today: ctx.today,
    scope: args.scope,
    updates: parsed.map(({ plan, ...rest }) => (plan === null ? rest : { ...rest, plan })),
  });
  return {
    scope: F.category(args.scope),
    expected: L.count(out.expected),
    covered: L.count(out.expected),
    missing: L.count(0),
    updated: L.count(out.updated),
    note: L.fixedText(
      "complete model assessment coverage saved; no decision or transaction was recorded",
    ),
  };
}
async function decision(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const id = reference("signal", args.signal_id),
    signal = Q.signalByGid(ctx.store.read, id);
  if (!signal) throw new ToolError("no such signal in this profile (see signals)", "not_found");
  const out = await execute(ctx, C.recordDecision, {
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
async function thesis(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const id = instrument(ctx, args.instrument),
    values: Record<string, unknown> = { entryType: args.entry_type, thesis: args.thesis };
  for (const [from, to] of [
    ["invalidation", "invalidation"],
    ["exit_plan", "exitPlan"],
    ["size_plan", "sizePlan"],
  ])
    if (from && to && args[from] != null) values[to] = args[from];
  const out = await execute(ctx, upsertThesisWithPlans(ctx.store.investmentWrites?.plans), {
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
export function watchRow(
  ctx: Context,
  row: ReturnType<InvestmentWriteServices["watchlist"]>[number],
  prospective?: Instrument,
): L.LabelledTree {
  const inst = Q.loadInstrument(ctx.store.read, row.instrument_id) ?? prospective,
    privateName = inst !== undefined && R.ownerNamed(inst),
    p = row.price,
    nearest = row.alerts.nearest,
    fresh = row.instrument?.plan_freshness;
  return {
    item_id: F.ref("watchlist", row.id),
    instrument: instrumentFields(ctx, row.instrument_id, prospective),
    note: L.text(row.note),
    tags: row.tags.map(L.category),
    source: L.category(row.source),
    added_at: F.date(row.added_at),
    held: L.flag(row.held),
    recommendation: L.category(row.instrument?.plan ?? null),
    strength: L.category(row.instrument?.strength ?? null),
    strength_basis: L.category(row.instrument?.strength_basis ?? null),
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
export function validateWatchArguments(
  ctx: ToolContext<Pick<NativeToolStore, "read">>,
  args: ToolArgs,
) {
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
  return { raw, explicit };
}
async function addWatch(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const { explicit } = validateWatchArguments(ctx, args);
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
  const out = await execute(ctx, addStoredWatchWithPlans(service.plans), {
    instrument: id,
    note: args.note,
  });
  const row = ctx.store.investmentWrites?.watchlist(out).find((r) => r.id === out.item);
  if (!row) throw new Error("prospective watch item missing");
  return {
    item: watchRow(ctx, row),
    created_instrument: L.flag(false),
    restored: L.flag(out.restored),
    warnings: [],
  };
}
async function removeWatch(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const id = reference("watchlist", args.id);
  const out = await execute(ctx, removeWatchWithPlans(ctx.store.investmentWrites?.plans), {
    item: id,
  });
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
async function strategy(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
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
  const out = await execute(ctx, createInvestmentProposal(files, base), {
    kind: "strategy",
    summary: `Strategy: ${config?.rules.length ?? 0} rules, ${config?.allocation.buckets.length ?? 0} buckets`,
    summaryParams: {
      rules: config?.rules.length ?? 0,
      buckets: config?.allocation.buckets.length ?? 0,
      inactive_rules: prepared.warnings.length,
    },
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
async function rule(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
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
  const out = await execute(ctx, createInvestmentProposal(files, base), {
    kind: "custom_rule",
    reason: args.reason ?? null,
    summary: `Rule ${prepared.entry.id} (${prepared.entry.kind}): fired ${"episodes" in backtest ? backtest.episodes : 0}x in backtest`,
    summaryParams: {
      rule_id: prepared.entry.id,
      rule_kind: prepared.entry.kind,
      episodes: "episodes" in backtest ? backtest.episodes : 0,
      evaluated: "evaluated" in backtest ? backtest.evaluated : 0,
    },
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
  propose_import: proposeInvestmentImport,
  search_instruments: searchInstruments,
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
  return NATIVE_TOOL_SCHEMAS.flatMap((metadata) => {
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
        handler: async (ctx: Context, args: ToolArgs) => {
          try {
            return await handler(ctx, args);
          } catch (e) {
            if (e instanceof StrategyProposalError) throw new ToolError(e.message, e.code);
            throw e;
          }
        },
      },
    ];
  });
}
