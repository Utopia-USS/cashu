/** Native research adapters. All writes use the host's single redact-before-commit buffer. */
import { addDays } from "@cashu/domain";
import { research } from "@cashu/domain/investments";
import {
  investmentsCommands as C,
  type Command,
  type CommandContext,
  defineCommand,
  ok,
  investmentsResearch as R,
} from "@cashu/store";
import * as Q from "@cashu/store/investments/queries";
import { addResearchNoteWithPlans } from "@cashu/store/investments/services";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError, type ToolSpec } from "../registry.js";
import { decodeEntityRef } from "../runtime/refs.js";
import { NATIVE_TOOL_SCHEMAS } from "../runtime/toolSchemas.js";
import type { NativeToolStore } from "../runtime/types.js";
import { researchContext } from "./researchContext.js";
import * as F from "./researchLabels.js";

type Context = ToolContext<NativeToolStore>;
const now = (ctx: Context) => R.eventInstant(new Date(ctx.store.now()).toISOString());
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  no_instrument:
    "no such instrument in this profile (held, watched or with an alert; see research_context)",
  ambiguous: "several instruments match; pass the instrument_id from research_context",
  not_researchable: "that instrument is owner-named (private) or cash: it is not researched",
  no_run: "no research run in this profile",
  run_not_running: "the research run is not running",
  run_running:
    "another research run is still running; finish it first or wait for it to be marked interrupted",
  owner_segment: "the owner set this segment; leave it",
  owner_thesis: "the owner has a thesis on this topic; leave it",
  topic_needs_thesis: "that topic has no thesis",
  rejected_draft: "the owner deleted this topic thesis; leave it until its cooldown expires",
  duplicate: "duplicate note (same scope, title or source)",
  duplicate_dismissed: "duplicate note (dismissed by the owner)",
  run_full: `a run holds at most ${R.MAX_NOTES_PER_RUN} notes`,
  segment_only: research.SEGMENT_ONLY,
  candidate_without_instrument:
    "a candidate note names its instrument: candidate {symbol_or_isin, name}",
  no_scope: "a note is about an instrument (instrument) or a market segment (segment)",
  topic_without_thesis:
    "that topic has no thesis: use thesis_relation none (see research_context segments[].thesis)",
  topic_thesis_draft:
    "the topic thesis is still a draft the owner has not confirmed: use thesis_relation none",
  relation_needs_thesis:
    "thesis_relation needs an instrument with a thesis, or a topic with a thesis",
  instrument_without_thesis:
    "that instrument has no thesis: use thesis_relation none (see research_context)",
  novelty_segments: `this week's research already has ${R.WEEKLY_SEGMENT_NOTES_MAX} segment notes; write only the segments where something changed`,
  novelty_instruments: `this week's research already covers ${R.WEEKLY_INSTRUMENTS_MAX} instruments; pick the material changes only (strength 3, invalidates or fulfills still pass)`,
  novelty_per_instrument: `this week's research already has ${R.WEEKLY_NOTES_PER_INSTRUMENT} notes on this instrument; pick the material changes only (strength 3, invalidates or fulfills still pass)`,
  macro_segment: "a macro regime has no thesis; a thesis belongs to a topic",
  invalid_status: "status must be done or failed",
  reason_too_long: `reason is too long (max ${research.REASON_MAX} characters)`,
};
function researchError(reason: string): ToolError {
  const kind = Object.hasOwn(R.RESEARCH_REFUSALS, reason)
    ? R.RESEARCH_REFUSALS[reason as R.ResearchRefusal]
    : reason === "owner_segment"
      ? "conflict"
      : "invalid";
  return new ToolError(REFUSAL_MESSAGES[reason] ?? `research refused: ${reason}`, kind);
}
async function execute<I, V>(ctx: Context, command: Command<I, V>, input: unknown): Promise<V> {
  const out = await ctx.store.run(command, input);
  if (!out.ok) {
    if (out.reason === "invalid_view") {
      const data = F.object(input),
        problems: string[] = [];
      for (const validate of [
        () => research.validateAssessment(data.assessment),
        () => research.validateOutlook(data.outlook, true),
        () => research.validateViewSources(data.sources, now(ctx)),
      ]) {
        try {
          validate();
        } catch (error) {
          if (!(error instanceof research.ResearchInputError)) throw error;
          problems.push(
            ...error.issues.map(([field, message]) => (field ? `${field}: ${message}` : message)),
          );
        }
      }
      if (problems.length > 0) throw new ToolError(problems.join("; "));
    }
    throw researchError(out.reason);
  }
  return out.value;
}
/** Capture actual emitted row fields without querying an uncommitted write or minting fake ids. */
function capture<I, V>(command: Command<I, V>, patch?: (ctx: CommandContext) => CommandContext) {
  return defineCommand({
    id: `${command.id}.mcp`,
    input: command.input,
    run(ctx, input) {
      const emitted: { type: string; gid: string; data: Record<string, unknown> }[] = [];
      const source = patch?.(ctx) ?? ctx;
      const out = command.run(
        {
          ...source,
          emit(type, gid, data, opts) {
            emitted.push({ type, gid, data });
            return source.emit(type, gid, data, opts);
          },
        },
        input,
      );
      return out.ok ? ok({ value: out.value, emitted }) : out;
    },
  });
}
function instrument(ctx: Context, value: unknown): string {
  if (typeof value !== "string") throw researchError("no_instrument");
  let reference = value;
  if (/^(?:instrument|loan|review|signal|thesis|alert|account|run|note|watchlist):/.test(value)) {
    try {
      reference = decodeEntityRef("instrument", value);
    } catch {
      throw researchError("no_instrument");
    }
  } else if ([...value].length > 40) {
    throw new ToolError("argument instrument is too long (max 40)", "invalid_arguments", {
      system: true,
    });
  }
  const found = R.resolveReference(ctx.store.read, reference);
  if (!found.ok) throw researchError(found.reason);
  return found.instrument;
}
function runId(ctx: Context, value: unknown): string {
  let gid: string;
  try {
    if (typeof value !== "string") throw new Error();
    gid = decodeEntityRef("run", value);
  } catch {
    throw researchError("no_run");
  }
  if (R.runByGid(ctx.store.read, gid) === undefined) throw researchError("no_run");
  return gid;
}
function researchNotes(ctx: Context, args: ToolArgs): L.LabelledTree {
  const since = research.parseMoment(
    typeof args.since === "string" && args.since ? args.since : addDays(ctx.today, -30),
  );
  if (since === null) throw new ToolError("since must be a date (YYYY-MM-DD) or an ISO timestamp");
  const rows = R.notes(ctx.store.read, now(ctx), {
    since,
    kinds: typeof args.kind === "string" ? [args.kind] : undefined,
    segment: typeof args.segment === "string" ? args.segment : undefined,
    includeDismissed: args.include_dismissed !== false,
    includeExpired: true,
    limit: typeof args.limit === "number" ? args.limit : 100,
  });
  const owned = new Set(
    [...Q.loadInstruments(ctx.store.read, Q.vaultInstrumentGids(ctx.store.read)).values()]
      .filter(R.ownerNamed)
      .map((i) => String(i.id)),
  );
  return {
    since: F.date(R.iso(since)),
    notes: R.notesView(ctx.store.read, rows, now(ctx), ctx.store.research?.plans.lang ?? "pl").map(
      (row) => F.note(row, ctx, owned),
    ),
    note: L.fixedText(
      "newest observation first; dismissed notes were rejected by the owner: do not add them again; a dismissed candidate is in cooldown (see research_context)",
    ),
  };
}
async function start(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const raw = F.object(args.scope);
  if (Object.hasOwn(raw, "themes"))
    throw new ToolError(
      "scope.themes is gone: use segments: [catalog keys] (research_context.segment_catalog)",
      "invalid_arguments",
    );
  const scope = {
    ...raw,
    ...(Array.isArray(raw.instruments)
      ? { instruments: raw.instruments.map((value) => instrument(ctx, value)) }
      : {}),
  };
  try {
    research.validateScope(args.scope === undefined ? null : scope);
  } catch (e) {
    if (e instanceof research.ResearchInputError) throw new ToolError(e.message);
    throw e;
  }
  const out = await execute(ctx, capture(R.startResearchRun), {
    scope: args.scope === undefined ? null : scope,
  });
  const data = out.emitted.find((e) => e.type === "researchRun.started")?.data;
  if (data === undefined) throw new Error("native research run was not prepared");
  const stored = F.object(data.scope);
  return {
    run_id: F.ref("run", out.value.run),
    status: L.category("running"),
    started_at: F.date(F.object(data.stamps).started_at),
    scope: {
      held: F.flag(stored.held),
      watchlist: F.flag(stored.watchlist),
      candidates: F.flag(stored.candidates),
      scheduled: F.flag(stored.scheduled),
      full_refresh: F.flag(stored.full_refresh),
      segments: F.array(stored.segments).map(F.category),
      covered_instruments: F.count(F.array(stored.covered_instrument_ids).length),
    },
    note: L.fixedText(
      "add notes with add_research_note (run_id optional while this run is running), then finish_research_run; research_context lists the instruments, theses and criteria",
    ),
  };
}
async function add(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const { instrument: reference, run_id, wording_ok, ...note } = args;
  let checked: research.NoteInput;
  try {
    checked = research.validateNote(note, now(ctx));
  } catch (e) {
    if (e instanceof research.ResearchInputError) throw new ToolError(e.message);
    throw e;
  }
  // A warning before anything is stored (a saved note cannot be edited): the agent rewrites the
  // flagged fields as facts, or confirms the wording with wording_ok.
  const flagged = research.noteWordingWarnings(checked);
  if (flagged.length > 0 && wording_ok !== true)
    throw new ToolError(
      `not saved yet: ${flagged.join(", ")} ${WORDING_WARNING}; to save it as written, resend with wording_ok true`,
    );
  const target = reference === undefined ? null : instrument(ctx, reference);
  const out = await execute(ctx, addResearchNoteWithPlans(ctx.store.research?.plans), {
    note,
    instrument: target,
    run: run_id === undefined ? null : runId(ctx, run_id),
    lang: ctx.store.research?.plans.lang ?? "pl",
  });
  return {
    note_id: F.ref("note", out.note),
    run_id: F.ref("run", out.row.run),
    kind: F.category(out.row.kind),
    instrument_id: F.ref("instrument", out.row.instrument),
    segment: F.category(out.row.segment),
    expires_at: F.date(R.iso(out.row.expiresAt)),
    signal:
      out.signal === null || out.signal.signal === null
        ? null
        : {
            signal_id: F.ref("signal", out.signal.signal),
            created: F.flag(out.signal.created),
            escalated: F.flag(out.signal.escalated),
          },
    warnings: out.warnings.map((warning) => F.text(noteWarning(warning))),
  };
}
const WORDING_WARNING =
  "reads like a forecast, a call, a rating or a price target. A note is a sourced fact: rewrite it " +
  "as what happened, or, if it is an opinion that follows from the owner's strategy (a target the " +
  "strategy computes, a buy / hold / sell view), put it in set_recommendations";

/** The agent-facing text of a value-free note warning code. */
function noteWarning(code: string): string {
  if (code === "not_held_or_watched")
    return "the instrument is neither held nor watched (it carries an alert)";
  if (code.startsWith("wording:"))
    return `${code.slice("wording:".length)}: saved as written (wording_ok); it ${WORDING_WARNING}`;
  return code;
}
async function finish(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const run = runId(ctx, args.run_id);
  try {
    research.validateCounts(args.counts === undefined ? null : F.object(args.counts));
  } catch (e) {
    if (e instanceof research.ResearchInputError) throw new ToolError(e.message);
    throw e;
  }
  const command = capture(R.finishResearchRun, (child) => ({
    ...child,
    lease: { isHolder: () => ctx.store.research?.isHolder(child.vault) === true },
  }));
  const out = await execute(ctx, command, {
    run,
    status: args.status ?? "done",
    counts: args.counts ?? null,
    reason: args.reason ?? null,
    lang: ctx.store.research?.plans.lang ?? "pl",
  });
  const data = out.emitted.find((e) => e.type === "researchRun.finished")?.data;
  if (data === undefined) throw new Error("native research finish was not prepared");
  const counts = F.object(data.counts),
    byKind = F.object(counts.by_kind);
  return {
    run_id: F.ref("run", run),
    status: F.category(data.status),
    finished_at: F.date(F.object(data.stamps).finished_at),
    counts: {
      notes: F.count(counts.notes),
      signals: F.count(counts.signals),
      candidates: F.count(counts.candidates),
      by_kind: Object.fromEntries(
        research.RESEARCH_NOTE_KINDS.map((kind) => [kind, F.count(byKind[kind])]),
      ),
      ...Object.fromEntries(
        research.RUN_COUNT_KEYS.filter((key) => Object.hasOwn(counts, key)).map((key) => [
          key,
          F.count(counts[key]),
        ]),
      ),
    },
    reason: F.text(counts.reason),
  };
}
async function setTopic(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const segment = String(args.segment),
    before = R.topicThesis(ctx.store.read, segment);
  const out = await execute(ctx, capture(R.setTopicMarketView), {
    segment,
    assessment: args.assessment,
    outlook: args.outlook,
    sources: args.sources,
    by: "agent",
  });
  const changed = out.emitted.find((e) => e.type === "topicThesis.marketViewSet")?.data;
  return {
    segment: F.category(segment),
    thesis_draft: F.flag(before?.draft),
    assessment: F.text(changed?.assessment ?? before?.assessment),
    outlook: F.text(changed?.outlook ?? before?.outlook),
    view_updated_at: F.date(
      changed === undefined
        ? R.iso(before?.viewUpdatedAt ?? null)
        : new Date(ctx.store.now()).toISOString(),
    ),
    view_sources: F.sources(changed?.sources ?? before?.viewSources),
    warnings: research
      .marketViewWarnings({
        assessment: typeof args.assessment === "string" ? args.assessment : null,
        outlook: typeof args.outlook === "string" ? args.outlook : null,
      })
      .map((where) =>
        F.text(
          `${where}: reads like a buy / sell call or a security price prediction; saved as written. ` +
            "The view describes the topic's market; a price view that follows from the owner's " +
            "strategy belongs in set_recommendations",
        ),
      ),
  };
}
async function upsertTopic(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const out = await execute(ctx, R.proposeTopicDraft, {
    segment: args.segment,
    thesis: args.thesis,
    invalidation: args.invalidation ?? null,
  });
  return {
    segment: F.category(args.segment),
    created: F.flag(out.created),
    draft: L.flag(true),
    note: L.fixedText(
      "saved as a draft the owner confirms or edits in the app (shown as [do potwierdzenia])",
    ),
  };
}
async function setSegment(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const target = instrument(ctx, args.instrument);
  if (
    !R.heldInstrumentGids(ctx.store.read, ctx.today).has(target) &&
    !Q.watchedInstrumentGids(ctx.store.read).has(target)
  )
    throw new ToolError("only a held or watched instrument gets a segment", "conflict");
  const out = await execute(ctx, C.setInstrumentSegment, {
    instrument: target,
    segment: args.segment,
    by: "agent",
  });
  const inst = Q.loadInstrument(ctx.store.read, target);
  if (inst === undefined) throw researchError("no_instrument");
  const [segment, source] = out.changed
    ? research.segmentOf(
        inst,
        typeof args.segment === "string" ? args.segment : null,
        typeof args.segment === "string" ? "agent" : null,
      )
    : research.segmentOf(inst, inst.segment, inst.segmentBy);
  return {
    instrument_id: F.ref("instrument", target),
    segment: F.category(segment),
    segment_source: F.category(source),
  };
}
const handlers: Readonly<Record<string, ToolSpec<NativeToolStore>["handler"]>> = {
  research_context: researchContext,
  research_notes: researchNotes,
  start_research_run: start,
  add_research_note: add,
  set_topic_market_view: setTopic,
  upsert_topic_thesis: upsertTopic,
  finish_research_run: finish,
  set_instrument_segment: setSegment,
};
/** Approved native-only schema difference: run refs are strings, never local integer aliases. */
export function researchTools(): readonly ToolSpec<NativeToolStore>[] {
  return NATIVE_TOOL_SCHEMAS.flatMap((metadata) => {
    const handler = handlers[metadata.name];
    if (handler === undefined) return [];
    const instrumentProperties =
      metadata.properties.instrument?.type === "string" &&
      metadata.properties.instrument.maxLength === 40
        ? {
            ...metadata.properties,
            instrument: { ...metadata.properties.instrument, maxLength: 64 },
          }
        : metadata.properties;
    const properties =
      metadata.name === "add_research_note" || metadata.name === "finish_research_run"
        ? {
            ...instrumentProperties,
            run_id: {
              type: "string",
              maxLength: 64,
              description: "opaque run reference from start_research_run or research_context",
            },
          }
        : instrumentProperties;
    return [{ ...metadata, properties, handler }];
  });
}
