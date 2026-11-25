// Topic theses (Python `research/topic_theses.py`, P9 / P11): the owner's thesis on a market topic
// (one per vault and segment, gid DET(segment)), the agent's drafts, the owner's delete (a rejection
// with a 90-day draft cooldown) and the market view under a live thesis. The commands check what
// Python checked before writing and emit `topicThesis.*`; the fold (topic-theses.ts) applies the same
// rules again in any order, so a concurrent write converges.
import type { UiLang } from "@cashu/domain/core";
import * as research from "@cashu/domain/investments/research";
import { z } from "zod";
import { canonicalJson } from "../../canonical.js";
import { defineCommand, ok, refuse } from "../../command.js";
import { TOPIC_INVALIDATION_MAX, TOPIC_THESIS_MAX } from "../../events/v1/research.js";
import { nowOf } from "./commands.js";
import { topicCooldownUntil, topicThesis, topicThesisRow } from "./queries.js";
import { iso, type TopicThesis } from "./rows.js";

export const OWNER = "owner";
/** Python `_CONTROL`: `[\x00-\x08\x0b-\x1f\x7f]` (tab and newline allowed). */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x08 || (cp >= 0x0b && cp <= 0x1f) || cp === 0x7f) return true;
  }
  return false;
}

/** Python `check_segment`: a catalog topic (macro regimes have no thesis). */
function checkSegment(segment: string): "macro_segment" | "invalid_segment" | null {
  if (research.isMacroKey(segment)) return "macro_segment";
  if (!research.isSegment(segment)) return "invalid_segment";
  return null;
}

type Cleaned = { ok: true; text: string | null } | { ok: false };

/** Python `_clean`: strip, normalise newlines, no control characters, at most `maximum` code points. */
function clean(value: unknown, maximum: number, required: boolean): Cleaned {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return required ? { ok: false } : { ok: true, text: null };
  }
  if (typeof value !== "string") return { ok: false };
  const text = value
    .trim()
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (hasControl(text) || [...text].length > maximum) return { ok: false };
  return { ok: true, text };
}

const segmentInput = z.string();

export const saveTopicThesis = defineCommand({
  id: "investments.research.saveTopicThesis",
  input: z.object({
    segment: segmentInput,
    thesis: z.unknown(),
    invalidation: z.unknown().default(null),
  }),
  /**
   * Python `save_owner` (`PUT`): creates or replaces the text and clears `draft` (confirming an agent
   * draft); `invalidation` null clears it. Returns whether a row was (re)started.
   */
  run(ctx, input) {
    const bad = checkSegment(input.segment);
    if (bad !== null) return refuse(bad);
    const thesis = clean(input.thesis, TOPIC_THESIS_MAX, true);
    const invalidation = clean(input.invalidation, TOPIC_INVALIDATION_MAX, false);
    if (!thesis.ok || !invalidation.ok) return refuse("invalid_thesis");
    const row = topicThesisRow(ctx.read, input.segment);
    const topic = ctx.det("inv_topic_theses", [input.segment]);
    ctx.emit("topicThesis.ownerSaved", topic, {
      segment: input.segment,
      thesis: thesis.text,
      invalidation: invalidation.text,
    });
    return ok({ topic, created: row === undefined || row.rejectedAt !== null });
  },
});

export const proposeTopicDraft = defineCommand({
  id: "investments.research.proposeTopicDraft",
  input: z.object({
    segment: segmentInput,
    thesis: z.unknown(),
    /** null / absent keeps the stored invalidation; a blank text clears it. */
    invalidation: z.unknown().default(null),
  }),
  /**
   * Python `upsert_draft`: the agent creates a draft or updates its own draft; an owner thesis (or a
   * confirmed draft) refuses `owner_thesis`, a draft the owner deleted within the cooldown refuses
   * `rejected_draft`.
   */
  run(ctx, input) {
    const bad = checkSegment(input.segment);
    if (bad !== null) return refuse(bad);
    const row = topicThesisRow(ctx.read, input.segment);
    const now = nowOf(ctx);
    if (row !== undefined && row.rejectedAt !== null) {
      const until = topicCooldownUntil(row);
      if (until !== null && until > now) return refuse("rejected_draft");
    } else if (row !== undefined && !row.draft) {
      return refuse("owner_thesis");
    }
    const thesis = clean(input.thesis, TOPIC_THESIS_MAX, true);
    const invalidation = clean(input.invalidation, TOPIC_INVALIDATION_MAX, false);
    if (!thesis.ok || !invalidation.ok) return refuse("invalid_thesis");
    const keep = input.invalidation === null || input.invalidation === undefined;
    const topic = ctx.det("inv_topic_theses", [input.segment]);
    ctx.emit("topicThesis.draftProposed", topic, {
      segment: input.segment,
      thesis: thesis.text,
      ...(keep ? {} : { invalidation: invalidation.text }),
    });
    return ok({ topic, created: row === undefined || row.rejectedAt !== null });
  },
});

export const deleteTopicThesis = defineCommand({
  id: "investments.research.deleteTopicThesis",
  input: z.object({ segment: segmentInput }),
  /**
   * Python `delete`: the owner deletes the topic thesis (his own, a confirmed or an agent draft); the
   * row stays as a rejection, so the agent may not propose a draft for 90 days.
   */
  run(ctx, input) {
    const bad = checkSegment(input.segment);
    if (bad !== null) return refuse(bad);
    const row = topicThesis(ctx.read, input.segment);
    if (row === undefined) return ok({ deleted: false });
    ctx.emit("topicThesis.rejected", row.gid, {});
    return ok({ deleted: true });
  },
});

const sameSources = (
  a: readonly unknown[] | null | undefined,
  b: readonly unknown[] | null | undefined,
): boolean => {
  const norm = (v: readonly unknown[] | null | undefined) =>
    v === null || v === undefined || v.length === 0 ? null : canonicalJson(v);
  return norm(a) === norm(b);
};

/** Python `blank`. */
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

function validated<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof research.ResearchInputError) return { ok: false };
    throw e;
  }
}

export const setTopicMarketView = defineCommand({
  id: "investments.research.setTopicMarketView",
  input: z.object({
    segment: segmentInput,
    assessment: z.unknown().default(null),
    outlook: z.unknown().default(null),
    /** Absent (undefined) keeps the stored sources (Python `KEEP`); null or [] clears them. */
    sources: z.unknown().optional(),
    by: z.enum(["agent", "owner"]).default("agent"),
  }),
  /**
   * Python `set_market_view` (P11): the agent writes both texts (its outlook names a quantitative
   * industry estimate) with 1-6 sources that replace the stored ones; the owner may edit or clear
   * either text, his sources are optional. A view cleared of both texts keeps no sources; the
   * thesis itself is never changed. Nothing is written when nothing changes.
   */
  run(ctx, input) {
    const bad = checkSegment(input.segment);
    if (bad !== null) return refuse(bad);
    const row = topicThesis(ctx.read, input.segment);
    if (row === undefined) return refuse("topic_needs_thesis");
    const agent = input.by === "agent";
    const now = nowOf(ctx);
    let failed = false;
    const check = <T>(fn: () => T): T | null => {
      const r = validated(fn);
      if (!r.ok) {
        failed = true;
        return null;
      }
      return r.value;
    };
    const assessment =
      agent || !blank(input.assessment)
        ? check(() => research.validateAssessment(input.assessment))
        : null;
    const outlook =
      agent || !blank(input.outlook)
        ? check(() => research.validateOutlook(input.outlook, agent))
        : null;
    const keep = input.sources === undefined;
    const clearing =
      !keep &&
      (input.sources === null || (Array.isArray(input.sources) && input.sources.length === 0));
    let sources: readonly unknown[] | null;
    if (agent || (!keep && !clearing)) {
      sources = check(() => research.validateViewSources(input.sources, now));
    } else if (keep) {
      sources = row.viewSources;
    } else {
      sources = null;
    }
    if (failed) return refuse("invalid_view");
    if (!(assessment || outlook)) sources = null;
    if (
      row.assessment === assessment &&
      row.outlook === outlook &&
      sameSources(row.viewSources, sources)
    ) {
      return ok({ topic: row.gid, changed: false });
    }
    const writeSources = agent || !keep || !(assessment || outlook);
    ctx.emit("topicThesis.marketViewSet", row.gid, {
      segment: input.segment,
      assessment,
      outlook,
      ...(writeSources
        ? { sources: sources === null || sources.length === 0 ? null : sources }
        : {}),
      by: input.by,
    });
    return ok({ topic: row.gid, changed: true });
  },
});

/** Python `thesis_dict`: the API shape of a topic thesis (null for none). */
export function topicThesisView(row: TopicThesis | undefined, lang: UiLang) {
  if (row === undefined) return null;
  return {
    id: row.gid,
    segment: row.segment,
    label: research.segmentLabel(row.segment, lang),
    thesis: row.thesis,
    invalidation: row.invalidation,
    assessment: row.assessment,
    outlook: row.outlook,
    view_updated_at: iso(row.viewUpdatedAt),
    view_sources: [...(row.viewSources ?? [])],
    draft: row.draft,
    created_by: row.createdBy,
    core_changed_at: iso(row.coreChangedAt),
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}
