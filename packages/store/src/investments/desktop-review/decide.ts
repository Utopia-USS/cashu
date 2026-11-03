/** Canonical owner subjects. Frozen membership never supplies authority for a later write. */
import { utcIso } from "@cashu/domain";
import { views } from "@cashu/domain/investments";
import { pendingProposals } from "../../core/proposal-execution.js";
import type { Read } from "../../query.js";
import type { ResearchInputs } from "../desktop-research/inputs.js";
import type { SignalRow } from "../desktop-signals/reads.js";
import { readSignalRows } from "../desktop-signals/reads.js";
import { theses } from "../queries/journal.js";

export interface ReviewDecideItem {
  readonly key: string;
  readonly kind: "subject" | "thesis" | "proposal" | "rules";
  readonly group: views.ReviewDecideGroup;
  readonly instrument: string | null;
  readonly title: string;
  readonly why: string;
  readonly facts: readonly string[];
  readonly signals: readonly string[];
  readonly note: string | null;
  readonly proposal: string | null;
  readonly thesis: string | null;
  readonly invalidation: string | null;
  readonly exitPlan: string | null;
  readonly lead?: SignalRow;
  readonly supporting?: readonly SignalRow[];
  readonly relation?: string | null;
  readonly ladder?: { readonly count: number; readonly since: string };
  readonly whySource?: "research" | "rule" | "health";
  readonly health?: { readonly from: string; readonly to: string };
}
export function readReviewDecide(
  read: Read,
  input: {
    now: string;
    since: string;
    account: string | null;
    research: ReturnType<ResearchInputs["digest"]>["value"];
  },
) {
  const now = Date.parse(input.now),
    since = views.reviewNewSince(Date.parse(input.since), now);
  const healthRelation: Readonly<Record<string, string>> = {
    invalidated: "invalidates",
    weak: "weakens",
    weakened: "weakens",
    fulfilled: "fulfills",
  };
  const health = new Map(
    input.research.theses_changed.flatMap((row) =>
      healthRelation[row.to] ? [[row.instrument_id, healthRelation[row.to] ?? ""] as const] : [],
    ),
  );
  const rows = readSignalRows(read, input.now, "open").filter(
    (row) => input.account === null || row.account === null || row.account === input.account,
  );
  const selection = views.reviewDecideSelection(
    rows.map((row) => ({
      id: row.gid,
      instrument: row.instrument,
      rule: row.ruleId,
      kind: row.kind,
      polarity: row.polarity,
      relation:
        row.source === "research" && typeof row.payload.relation === "string"
          ? row.payload.relation
          : null,
      firstSeen: Date.parse(utcIso(row.firstSeenAt)),
      threshold: Number(row.payload.threshold) || 0,
      open: true,
      snoozed: row.snoozed,
      decided: row.decisions.length > 0,
      bucket: typeof row.payload.bucket_id === "string" ? row.payload.bucket_id : null,
      row,
    })),
    { now, since, health },
  );
  const currentTheses = theses(read);
  const items: ReviewDecideItem[] = [],
    stale = selection.stale.map((s) => s.row);
  const rest = selection.rest;
  for (const selected of selection.selected) {
    const sub = selected.subject,
      all = [...sub.live, ...sub.ladder],
      changing = selected.changing;
    const rel = changing?.relation ?? selected.healthRelation,
      fresh = selected.fresh;
    const thesis = currentTheses.find((row) => row.instrument === sub.instrument);
    const last = Math.max(...all.map((row) => row.firstSeen).filter(Number.isFinite));
    const group = views.reviewSubjectGroup({
      relation: rel,
      polarities: fresh.map((row) => row.polarity),
      hasExitPlan: !!thesis?.exitPlan?.trim(),
      exitPlanChangedAt:
        thesis?.exitPlanChangedAt == null
          ? Number.NaN
          : Date.parse(utcIso(thesis.exitPlanChangedAt)),
      lastSeen: last,
    });
    const speaking = changing ?? fresh[0];
    const lead = speaking ?? sub.live[0];
    if (!lead) continue;
    items.push({
      key: `s:${sub.key}`,
      kind: "subject",
      group,
      instrument: sub.instrument,
      title: lead.row.instrumentLabel ?? "",
      why: changing
        ? String(
            changing.row.payload.headline ?? changing.row.payload.title ?? changing.row.message,
          )
        : lead.row.message,
      lead: lead.row,
      supporting: sub.live
        .filter((row) => row !== speaking && row.row.source !== "research")
        .map((row) => row.row),
      relation: rel,
      whySource: changing ? "research" : fresh.length ? "rule" : "health",
      ladder: {
        count: speaking ? sub.ladder.filter((row) => row.kind === speaking.kind).length + 1 : 1,
        since: speaking
          ? (sub.ladder
              .filter((row) => row.kind === speaking.kind)
              .map((row) => row.row.firstSeenAt)
              .sort()[0] ?? speaking.row.firstSeenAt)
          : lead.row.firstSeenAt,
      },
      facts: sub.live
        .filter((row) => row !== speaking && row.row.source !== "research")
        .map((row) => row.row.message),
      signals: all.map((row) => row.id),
      note: changing?.row.note ?? null,
      proposal: null,
      thesis: thesis?.thesis ?? null,
      invalidation: thesis?.invalidation ?? null,
      exitPlan: thesis?.exitPlan ?? null,
    });
  }
  const covered = new Set(items.map((row) => row.instrument));
  for (const changed of input.research.theses_changed) {
    if (covered.has(changed.instrument_id) || !healthRelation[changed.to]) continue;
    const thesis = currentTheses.find((row) => row.instrument === changed.instrument_id);
    items.push({
      key: `t:${changed.instrument_id}`,
      kind: "thesis",
      group: changed.to === "fulfilled" ? "chance" : "risk",
      instrument: changed.instrument_id,
      title: changed.label ?? changed.instrument_id,
      why: changed.to,
      health: { from: changed.from, to: changed.to },
      facts: [],
      signals: [],
      note: changed.note_ids[0] ?? null,
      proposal: null,
      thesis: thesis?.thesis ?? null,
      invalidation: thesis?.invalidation ?? null,
      exitPlan: thesis?.exitPlan ?? null,
    });
  }
  const order = ["risk", "chance", "mixed", "plan", "fix"];
  items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const shown = items.slice(0, 6);
  for (const proposal of pendingProposals(read))
    shown.push({
      key: `p:${proposal.gid}`,
      kind: "proposal",
      group: "plan",
      instrument: null,
      title: proposal.summary,
      why: proposal.reason ?? "",
      facts: [],
      signals: [],
      note: null,
      proposal: proposal.gid,
      thesis: null,
      invalidation: null,
      exitPlan: null,
    });
  if (stale.length)
    shown.push({
      key: "rules",
      kind: "rules",
      group: "fix",
      instrument: null,
      title: "",
      why: "",
      facts: stale.map((row) => row.message),
      signals: stale.map((row) => row.gid),
      note: null,
      proposal: null,
      thesis: null,
      invalidation: null,
      exitPlan: null,
    });
  return { items: shown, more: Math.max(0, items.length - 6), rest };
}
