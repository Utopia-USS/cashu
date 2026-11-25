/** Source-shaped labelled projections over native research DTOs. No policy or business arithmetic. */
import { parseDateTime } from "@cashu/domain";
import * as L from "../privacy/labels.js";
import { type ToolContext, ToolError } from "../registry.js";
import { type EntityRefKind, encodeEntityRef } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
export const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
export function truthy(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === "" ||
    value === 0 ||
    value === 0n
  )
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
function scalar(value: unknown): L.LeafValue {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    )
      return value;
  }
  throw new ToolError("stored research contains invalid data", "privacy_error");
}
export const text = (v: unknown) => new L.Labelled(scalar(v), "text");
export const category = (v: unknown) => new L.Labelled(scalar(v), "category");
export const count = (v: unknown) =>
  typeof v === "number" || typeof v === "bigint" ? L.count(v) : new L.Labelled(scalar(v), "count");
export const symbol = (v: unknown) => new L.Labelled(scalar(v), "symbol");
export const flag = (v: unknown) => L.flag(truthy(v));
export const percent = (v: unknown) => L.pct(typeof v === "number" ? v : null);
export function date(v: unknown) {
  if (typeof v !== "string") return new L.Labelled(scalar(v), "date");
  return L.date(v.includes("T") || v.includes(" ") ? parseDateTime(v) : v);
}
export function ref(kind: EntityRefKind, value: unknown) {
  if (value === null || value === undefined) return L.ref(null);
  if (typeof value !== "string")
    throw new ToolError("stored research reference is invalid", "privacy_error");
  return L.ref(encodeEntityRef(kind, value));
}
export function sources(value: unknown): L.LabelledTree[] {
  return array(value)
    .filter((v) => v !== null && typeof v === "object" && !Array.isArray(v))
    .map((value) => {
      const s = object(value);
      return {
        publisher: text(s.publisher),
        title: text(s.title),
        url: text(s.url),
        published_at: date(s.published_at),
      };
    });
}
export function valuation(value: unknown): L.LabelledTree {
  if (!truthy(value)) return null;
  const v = object(value);
  return {
    pe: L.level(typeof v.pe === "number" ? v.pe : null),
    forward_pe: L.level(typeof v.forward_pe === "number" ? v.forward_pe : null),
    eps_growth: percent(v.eps_growth),
    pe_avg_5y: L.level(typeof v.pe_avg_5y === "number" ? v.pe_avg_5y : null),
    basis: text(v.basis),
    observed_at: date(v.observed_at),
  };
}
export function brief(value: unknown): L.LabelledTree {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = object(value);
  return {
    headline: text(v.headline),
    why: text(v.why),
    supports: array(v.supports).map(text),
    risks: array(v.risks).map(text),
  };
}
export function instrument(
  value: unknown,
  ctx: ToolContext<NativeToolStore>,
  privateName = false,
): Record<string, L.Labelled> {
  if (!truthy(value)) return { instrument_id: L.ref(null) };
  const v = object(value),
    name = typeof v.name === "string" ? v.name : null;
  return {
    instrument_id: ref("instrument", v.id),
    symbol: privateName ? L.identifier(scalar(v.symbol)) : symbol(v.symbol),
    isin: symbol(v.isin),
    name: privateName ? L.identifier(name) : text(ctx.strict ? ctx.guard.publicName(name) : name),
    asset_class: category(v.asset_class),
    currency: category(v.currency),
  };
}
export function thesis(value: unknown): L.LabelledTree {
  if (!truthy(value)) return null;
  const v = object(value);
  return {
    thesis_id: ref("thesis", v.gid ?? v.id),
    entry_type: category(v.entryType ?? v.entry_type),
    thesis: text(v.thesis),
    invalidation: text(v.invalidation),
    exit_plan: text(v.exitPlan ?? v.exit_plan),
    size_plan: text(v.sizePlan ?? v.size_plan),
    draft: flag(v.draft),
    updated_at: date(v.updated_at ?? v.updatedAt),
    core_changed_at: date(v.core_changed_at ?? v.coreChangedAt ?? v.updated_at ?? v.updatedAt),
  };
}
export function researchFields(value: unknown): L.LabelledTree {
  const v = object(value);
  return {
    health: category(v.health),
    health_predates_thesis: flag(v.health_predates_thesis),
    counts: Object.fromEntries(Object.entries(object(v.counts)).map(([k, x]) => [k, count(x)])),
    sentiment_8w: array(v.sentiment_8w).map(percent),
    direction: category(v.direction),
    last_researched_at: date(v.last_researched_at),
  };
}
export function run(value: unknown): L.LabelledTree {
  if (!truthy(value)) return null;
  const v = object(value);
  return {
    run_id: ref("run", v.id),
    status: category(v.status),
    interrupted: flag(v.interrupted),
    scheduled: flag(v.scheduled),
    full_refresh: flag(v.full_refresh),
    started_at: date(v.started_at),
    finished_at: date(v.finished_at),
    notes: count(v.notes),
    signals: count(v.signals),
    candidates: count(object(v.counts).candidates),
  };
}
export function topicThesis(value: unknown): L.LabelledTree {
  if (!truthy(value)) return null;
  const v = object(value);
  return {
    text: text(v.thesis),
    invalidation: text(v.invalidation),
    assessment: text(v.assessment),
    outlook: text(v.outlook),
    view_updated_at: date(v.view_updated_at),
    view_sources: sources(v.view_sources),
    draft: flag(v.draft),
    created_by: category(v.created_by),
    updated_at: date(v.updated_at),
  };
}
export function note(
  value: unknown,
  ctx: ToolContext<NativeToolStore>,
  owned: ReadonlySet<string>,
): L.LabelledTree {
  const v = object(value),
    details = object(v.details),
    cand = object(v.candidate),
    inst = object(v.instrument);
  return {
    note_id: ref("note", v.id),
    run_id: ref("run", v.run_id),
    kind: category(v.kind),
    polarity: category(v.polarity),
    strength: count(v.strength),
    thesis_relation: category(v.thesis_relation),
    thesis_field: category(v.thesis_field),
    predates_thesis: flag(v.predates_thesis),
    title: text(v.title),
    summary: text(v.summary),
    instrument: v.instrument
      ? instrument(inst, ctx, typeof inst.id === "string" && owned.has(inst.id))
      : null,
    theme: text(v.theme),
    segment: category(v.segment),
    segment_label: category(v.segment_label),
    candidate: v.candidate
      ? {
          symbol: symbol(cand.symbol),
          key: symbol(cand.key),
          name: text(cand.name),
          accepted: flag(cand.accepted_at),
          cooldown_until: date(v.cooldown_until),
        }
      : null,
    details: truthy(v.details)
      ? {
          entry_type: category(details.entry_type),
          criteria: array(details.criteria).map((c) => {
            const row = object(c);
            return { text: text(row.text), met: flag(row.met), threshold: text(row.threshold) };
          }),
          context: text(details.context),
          bucket: category(details.bucket),
          scale: category(details.scale),
          event: text(details.event),
          event_date: date(details.event_date),
          headline: text(details.headline),
          valuation: valuation(details.valuation),
          brief: brief(details.brief),
        }
      : null,
    sources: sources(v.sources),
    signal_id: ref("signal", v.signal_id),
    observed_at: date(v.observed_at),
    expires_at: date(v.expires_at),
    expired: flag(v.expired),
    dismissed: flag(v.dismissed),
    dismissed_at: date(v.dismissed_at),
    created_at: date(v.created_at),
  };
}
