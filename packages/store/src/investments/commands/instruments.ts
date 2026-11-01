// Instrument commands (Python `store/instruments.py`, write side): store a planned instrument with its
// aliases, add aliases, classify, set the status, the model recommendation (legacy name `plan`) and
// the market segment, and record a manual valuation. Market identity (the instrument row, aliases)
// is per vault (D3); the owner's classification goes to the vault's override row
// (`instrumentOverride.*`), so another vault's view of the same security never changes.
import {
  AliasNamespace,
  defaultValuationMode,
  HELD_ONLY_PLANS,
  research,
  type ValuationMode,
} from "@cashu/domain/investments";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import {
  ASSET_CLASSES,
  INSTRUMENT_STATUSES,
  PLAN_VALUES,
  SEGMENT_SETTERS,
  VALUATION_MODES,
} from "../../events/v1/investments.js";
import { assetCurrency, calendarDate, decimal, gid } from "../../events/v1/primitives.js";
import { aliasOwner, loadInstrument, normalizeAlias, overrides } from "../queries/instruments.js";
import { instrumentGid } from "../queries/shared.js";

const aliasInput = z.object({
  namespace: z.string().regex(/^[a-z0-9_]+$/),
  value: z.string(),
  guessed: z.boolean().default(false),
});
type AliasInput = z.infer<typeof aliasInput>;

/** Python `PLAN_REASON_MAX`: the model's reason is at most this many characters. */
export const PLAN_REASON_MAX = 280;

/**
 * Python `add_aliases`: claim the aliases nobody holds yet (`instrument.aliasAdded`); an alias the
 * instrument holds as a guess and now gets confirmed is claimed again with `guessed: false`; an ISIN
 * alias also fills the display ISIN when the instrument has none. An alias held by ANOTHER instrument
 * is skipped: claiming it would merge the two (identity, events.md 6.4), which only an explicit merge
 * may do. Returns the number of aliases claimed.
 */
export function addAliases(
  ctx: CommandContext,
  instrument: string,
  isin: string | null,
  aliases: readonly AliasInput[],
): number {
  let added = 0;
  let displayIsin = isin;
  const seen = new Set<string>();
  for (const alias of aliases) {
    const value = normalizeAlias(alias.namespace, alias.value);
    if (!value || seen.has(`${alias.namespace}:${value}`)) continue;
    seen.add(`${alias.namespace}:${value}`);
    const owner = aliasOwner(ctx.read, alias.namespace, value);
    if (owner !== undefined) {
      if (owner.instrument === instrument && owner.guessed && !alias.guessed) {
        // confirm the guess: the fold ANDs `guessed` over the alias's claims (events.md 8.6)
        ctx.emit(
          "instrument.aliasAdded",
          ctx.det("inv_instrument_aliases", [alias.namespace, value]),
          {
            instrument,
            namespace: alias.namespace,
            value,
            guessed: false,
          },
        );
      }
      continue;
    }
    ctx.emit("instrument.aliasAdded", ctx.det("inv_instrument_aliases", [alias.namespace, value]), {
      instrument,
      namespace: alias.namespace,
      value,
      guessed: alias.guessed,
    });
    added += 1;
    if (alias.namespace === AliasNamespace.ISIN && !displayIsin) {
      displayIsin = value;
      ctx.emit("instrument.updated", instrument, { isin: value });
    }
  }
  return added;
}

const nullableText = z.string().nullable().optional();

/** A planned instrument (`createInstrument` input; `instrumentSpec.parse` fills the defaults). */
export const instrumentSpec = z.object({
  name: z.string().min(1),
  currency: assetCurrency,
  assetClass: z.enum(ASSET_CLASSES),
  symbol: nullableText,
  isin: nullableText,
  mic: nullableText,
  region: nullableText,
  sector: nullableText,
  tags: z.array(z.string()).default([]),
  needsClassification: z.boolean().default(false),
  valuationMode: z.enum(VALUATION_MODES).nullable().optional(),
  status: z.enum(INSTRUMENT_STATUSES).default("active"),
  aliases: z.array(aliasInput).default([]),
});

/** What `storeInstrument` stores (defaults filled). */
export type InstrumentSpec = z.infer<typeof instrumentSpec>;

/**
 * Python `insert`: the instrument and the aliases nobody holds yet. The gid is DET of its creation
 * alias (gid.md 4.6: `isin:<ISIN>` when it has an ISIN, else its first alias), so two devices
 * storing the same planned instrument converge on one row; ULID without any alias. When the
 * creation alias already belongs to an instrument, that one is returned and nothing is written.
 * A building block for commands that store instruments inside their own batch (imports, manual
 * transactions, the watchlist); it sees only the view, so the caller keeps the planned instruments of
 * one batch apart (distinct creation aliases).
 */
/**
 * The creation alias of a planned instrument (gid.md 4.6): `isin:<ISIN>` when it has an ISIN (the
 * column, else an ISIN alias), else its first alias, null without any; the instrument's DET gid is
 * derived from it.
 */
export function creationAliasOf(input: Pick<InstrumentSpec, "isin" | "aliases">): string | null {
  const aliases = input.aliases
    .map((a) => ({ ...a, value: normalizeAlias(a.namespace, a.value) }))
    .filter((a) => a.value !== "");
  const isin =
    (input.isin ? input.isin.trim().toUpperCase() : null) ||
    (aliases.find((a) => a.namespace === AliasNamespace.ISIN)?.value ?? null);
  const first = aliases[0];
  if (isin) return `${AliasNamespace.ISIN}:${isin}`;
  return first === undefined ? null : `${first.namespace}:${first.value}`;
}

export function storeInstrument(
  ctx: CommandContext,
  input: InstrumentSpec,
  /** The gid of an instrument without any alias (default a fresh ULID): a caller that keyed rows by it first. */
  ulid?: string,
): { readonly gid: string; readonly created: boolean } {
  const aliases = input.aliases
    .map((a) => ({ ...a, value: normalizeAlias(a.namespace, a.value) }))
    .filter((a) => a.value !== "");
  const isin =
    (input.isin ? input.isin.trim().toUpperCase() : null) ||
    (aliases.find((a) => a.namespace === AliasNamespace.ISIN)?.value ?? null);
  const creationAlias = creationAliasOf(input);
  if (creationAlias !== null) {
    const [namespace = "", ...rest] = creationAlias.split(":");
    const held = aliasOwner(ctx.read, namespace, rest.join(":"));
    if (held !== undefined) return { gid: held.instrument, created: false };
    const existing = instrumentGid(ctx.read, ctx.det("inv_instruments", [creationAlias]));
    if (existing !== undefined) return { gid: existing, created: false };
  }
  const gidOf =
    creationAlias === null ? (ulid ?? ctx.newGid()) : ctx.det("inv_instruments", [creationAlias]);
  ctx.emit("instrument.created", gidOf, {
    name: input.name,
    currency: input.currency,
    assetClass: input.assetClass,
    symbol: input.symbol || null,
    isin,
    mic: input.mic || null,
    region: input.region ?? null,
    sector: input.sector ?? null,
    tags: [...input.tags],
    needsClassification: input.needsClassification,
    valuationMode: input.valuationMode ?? defaultValuationMode(input.assetClass),
    status: input.status,
    creationAlias,
  });
  // Writers emit `aliasAdded` for every alias, the creation alias included (events.md 8.6).
  const claims =
    isin && !aliases.some((a) => a.namespace === AliasNamespace.ISIN && a.value === isin)
      ? [{ namespace: AliasNamespace.ISIN, value: isin, guessed: false }, ...aliases]
      : aliases;
  addAliases(ctx, gidOf, isin, claims);
  return { gid: gidOf, created: true };
}

export const createInstrument = defineCommand({
  id: "investments.createInstrument",
  input: instrumentSpec,
  run: (ctx, input) => ok(storeInstrument(ctx, input)),
});

export const addInstrumentAliases = defineCommand({
  id: "investments.addInstrumentAliases",
  input: z.object({ instrument: gid, aliases: z.array(aliasInput).min(1) }),
  run(ctx, input) {
    const current = loadInstrument(ctx.read, input.instrument, { shared: true });
    if (current === undefined) return refuse("no_instrument");
    return ok({ added: addAliases(ctx, current.id, current.isin, input.aliases) });
  },
});

export const classifyInstrument = defineCommand({
  id: "investments.classifyInstrument",
  input: z.object({
    instrument: gid,
    assetClass: z.enum(ASSET_CLASSES).optional(),
    tags: z.array(z.string()).optional(),
    valuationMode: z.enum(VALUATION_MODES).optional(),
    region: z.string().optional(),
    sector: z.string().optional(),
    name: z.string().optional(),
    status: z.enum(INSTRUMENT_STATUSES).optional(),
    aliases: z.array(aliasInput).default([]),
    reviewed: z.boolean().default(true),
  }),
  /**
   * Python `classify`: how this vault classifies an instrument (its override row); `reviewed` clears
   * `needs_classification`. A new asset class moves the valuation mode along when it was the old
   * class's default. Aliases are market identity, confirmed; an alias of another instrument refuses
   * the whole command (`alias_taken`) before anything is written.
   */
  run(ctx, input) {
    const current = loadInstrument(ctx.read, input.instrument);
    if (current === undefined) return refuse("no_instrument");
    for (const alias of input.aliases) {
      const owner = aliasOwner(ctx.read, alias.namespace, alias.value);
      if (owner !== undefined && owner.instrument !== current.id) return refuse("alias_taken");
    }
    const patch: Record<string, unknown> = {};
    let valuationMode: ValuationMode | undefined = input.valuationMode;
    if (input.assetClass !== undefined) {
      if (
        valuationMode === undefined &&
        current.valuationMode === defaultValuationMode(current.assetClass)
      ) {
        valuationMode = defaultValuationMode(input.assetClass);
      }
      patch.assetClass = input.assetClass;
    }
    if (valuationMode !== undefined) patch.valuationMode = valuationMode;
    if (input.status !== undefined) patch.status = input.status;
    if (input.tags !== undefined) {
      patch.tags = [...new Set(input.tags.map((t) => t.trim()).filter((t) => t !== ""))];
    }
    if (input.region !== undefined) patch.region = input.region.trim();
    if (input.sector !== undefined) patch.sector = input.sector.trim();
    if (input.name?.trim()) patch.name = input.name.trim();
    if (input.reviewed) patch.needsClassification = false;
    if (Object.keys(patch).length > 0) {
      ctx.emit("instrumentOverride.set", ctx.det("inv_profile_instruments", [current.id]), {
        instrument: current.id,
        ...patch,
      });
    }
    const shared = loadInstrument(ctx.read, current.id, { shared: true });
    addAliases(
      ctx,
      current.id,
      shared?.isin ?? null,
      input.aliases.map((a) => ({ ...a, guessed: false })),
    );
    return ok({ instrument: current.id });
  },
});

export const setInstrumentStatus = defineCommand({
  id: "investments.setInstrumentStatus",
  input: z.object({ instrument: gid, status: z.enum(INSTRUMENT_STATUSES) }),
  /** Python `set_status`: the status (frozen / delisted from an import) for this vault only. */
  run(ctx, input) {
    const current = loadInstrument(ctx.read, input.instrument);
    if (current === undefined || current.status === input.status) return ok({ changed: false });
    ctx.emit("instrumentOverride.set", ctx.det("inv_profile_instruments", [current.id]), {
      instrument: current.id,
      status: input.status,
    });
    return ok({ changed: true });
  },
});

export const setInstrumentPlan = defineCommand({
  id: "investments.setInstrumentPlan",
  input: z.object({
    instrument: gid,
    plan: z.enum(PLAN_VALUES).nullable(),
    /** Whether the vault holds the instrument (the caller's portfolio view). */
    held: z.boolean(),
    reason: z.string().nullable().optional(),
  }),
  /**
   * Python `set_plan`: the model recommendation (null clears it with its reason; `plan_at` = the
   * event's domain time). The reason is whitespace-collapsed, at most PLAN_REASON_MAX characters; a
   * reduce / exit recommendation needs a held instrument.
   */
  run(ctx, input) {
    const reason = (input.reason ?? "").split(/\s+/).filter(Boolean).join(" ") || null;
    if (reason !== null && reason.length > PLAN_REASON_MAX) return refuse("reason_too_long");
    if (input.plan !== null && HELD_ONLY_PLANS.has(input.plan) && !input.held) {
      return refuse("needs_held");
    }
    const root = instrumentGid(ctx.read, input.instrument);
    if (root === undefined) return refuse("no_instrument");
    ctx.emit("instrumentOverride.planSet", ctx.det("inv_profile_instruments", [root]), {
      instrument: root,
      plan: input.plan,
      reason: input.plan === null ? null : reason,
    });
    return ok({ instrument: root });
  },
});

export const setInstrumentSegment = defineCommand({
  id: "investments.setInstrumentSegment",
  input: z.object({
    instrument: gid,
    segment: z.string().nullable(),
    by: z.enum(SEGMENT_SETTERS),
  }),
  /**
   * Python `set_segment`: the market segment (a `research.segments` key; null clears it) on behalf of
   * the owner (the app) or the agent (MCP). The agent never changes or clears the owner's value
   * (`owner_segment`; the fold re-checks it, events.md 8.6). Unchanged = nothing written.
   */
  run(ctx, input) {
    if (research.isMacroKey(input.segment)) return refuse("not_instrument_segment");
    if (input.segment !== null && !research.isSegment(input.segment)) {
      return refuse("unknown_segment");
    }
    const root = instrumentGid(ctx.read, input.instrument);
    if (root === undefined) return refuse("no_instrument");
    const row = overrides(ctx.read, [root]).get(root);
    if ((row?.segment ?? null) === input.segment) return ok({ changed: false });
    if (input.by === "agent" && row?.segment != null && (row.segmentBy ?? "owner") === "owner") {
      return refuse("owner_segment");
    }
    ctx.emit("instrumentOverride.segmentSet", ctx.det("inv_profile_instruments", [root]), {
      instrument: root,
      segment: input.segment,
      by: input.by,
    });
    return ok({ changed: true });
  },
});

export const setManualValuation = defineCommand({
  id: "investments.setManualValuation",
  input: z.object({
    instrument: gid,
    asOf: calendarDate,
    unitValue: decimal,
    currency: assetCurrency,
    note: z.string().nullable().default(null),
  }),
  /** Python `upsert_manual_valuation`: one value per (instrument, date), LWW-F on the row key. */
  run(ctx, input) {
    const root = instrumentGid(ctx.read, input.instrument);
    if (root === undefined) return refuse("no_instrument");
    ctx.emit("valuation.set", ctx.det("inv_manual_valuations", [root, input.asOf]), {
      instrument: root,
      asOf: input.asOf,
      unitValue: input.unitValue,
      currency: input.currency,
      note: input.note,
    });
    return ok({ instrument: root });
  },
});
