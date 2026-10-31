// Topic theses (events.md 8.9, M9; S25 spec 4.12), mirroring Python `research/topic_theses.py`. One
// row per segment (gid DET(segment), partition = the gid):
// - a write (`ownerSaved` / `draftProposed`) on a REJECTED row restarts it: `rejected_at` cleared,
//   `created_by` = the writer, `draft` = (writer is the agent), `created_at` = `core_changed_at` =
//   domain time, `invalidation` cleared (then set from the event), the market view cleared;
// - GUARD `draftProposed`: a no-op on a live owner thesis (not rejected, not a draft), or on a row
//   rejected less than TOPIC_DRAFT_COOLDOWN_DAYS before the event's domain time;
// - otherwise text LWW (`draftProposed` without `invalidation` keeps the stored one),
//   `core_changed_at` = domain time when thesis / invalidation change by value, `ownerSaved` clears
//   `draft` (keeps `created_by`); `updated_at` = domain time of every applied write;
// - `rejected` (SOFT): `rejected_at` = `updated_at` = domain time; a no-op on a rejected row;
// - `marketViewSet`: a no-op on a missing or rejected row and when nothing changes; `sources` absent =
//   keep, a view cleared of both texts keeps no sources; `view_updated_at` = domain time when a text
//   is set, else null; `updated_at` = domain time.
import { research } from "@cashu/domain/investments";
import { canonicalJson } from "../canonical.js";
import type { FoldContext, FoldEvent, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { json, str } from "./fold-values.js";

const DAY_MS = 86_400_000;

const table: TableDef = {
  name: "inv_topic_theses",
  columns: [
    { name: "segment", type: "TEXT", notNull: true },
    { name: "thesis", type: "TEXT", notNull: true },
    { name: "invalidation", type: "TEXT" },
    { name: "draft", type: "INTEGER", notNull: true, default: "0" },
    { name: "created_by", type: "TEXT", notNull: true, default: "'owner'" },
    { name: "core_changed_at", type: "TEXT", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
    { name: "rejected_at", type: "TEXT" },
    { name: "assessment", type: "TEXT" },
    { name: "outlook", type: "TEXT" },
    { name: "view_updated_at", type: "TEXT" },
    { name: "view_sources", type: "TEXT", json: true },
  ],
  indexes: [{ columns: ["segment"], unique: true }],
};

interface Row {
  segment: string;
  thesis: string;
  invalidation: string | null;
  draft: number;
  created_by: string;
  core_changed_at: string;
  created_at: string;
  updated_at: string;
  rejected_at: string | null;
  assessment: string | null;
  outlook: string | null;
  view_updated_at: string | null;
  view_sources: string | null;
}

const COLUMNS: readonly (keyof Row)[] = [
  "segment",
  "thesis",
  "invalidation",
  "draft",
  "created_by",
  "core_changed_at",
  "created_at",
  "updated_at",
  "rejected_at",
  "assessment",
  "outlook",
  "view_updated_at",
  "view_sources",
];

/** View timestamp (`YYYY-MM-DD HH:MM:SS.ffffff`, UTC) -> epoch ms. */
function epochMs(view: string): number {
  return Date.parse(`${view.slice(0, 10)}T${view.slice(11, 23)}Z`);
}

function save(ctx: FoldContext, gid: string, row: Row): void {
  ctx.sql.write(
    table.name,
    `INSERT OR REPLACE INTO inv_topic_theses (id, gid, ${COLUMNS.join(", ")})
     VALUES (?, ?, ${COLUMNS.map(() => "?").join(", ")})`,
    ctx.id(gid),
    gid,
    ...COLUMNS.map((c) => row[c]),
  );
}

function write(e: FoldEvent, ctx: FoldContext, row: Row | undefined): Row | undefined {
  const d = e.data;
  const agent = e.type === "topicThesis.draftProposed";
  const by = agent ? "agent" : "owner";
  const now = ctx.time(e, "updated_at");
  const text = String(d.thesis);
  if (row !== undefined && row.rejected_at !== null) {
    if (
      agent &&
      epochMs(now) < epochMs(row.rejected_at) + research.TOPIC_DRAFT_COOLDOWN_DAYS * DAY_MS
    ) {
      return undefined; // GUARD: rejected too recently for a new draft
    }
    // A rejected row starts over (the owner's own thesis, or a new draft after the cooldown).
    const at = ctx.time(e, "created_at");
    return {
      ...row,
      thesis: text,
      invalidation: str(d.invalidation),
      draft: agent ? 1 : 0,
      created_by: by,
      created_at: at,
      core_changed_at: ctx.time(e, "core_changed_at"),
      updated_at: now,
      rejected_at: null,
      assessment: null,
      outlook: null,
      view_updated_at: null,
      view_sources: null,
    };
  }
  if (row === undefined) {
    return {
      segment: String(d.segment),
      thesis: text,
      invalidation: str(d.invalidation),
      draft: agent ? 1 : 0,
      created_by: by,
      core_changed_at: ctx.time(e, "core_changed_at"),
      created_at: ctx.time(e, "created_at"),
      updated_at: now,
      rejected_at: null,
      assessment: null,
      outlook: null,
      view_updated_at: null,
      view_sources: null,
    };
  }
  if (agent && row.draft === 0) return undefined; // GUARD: never over a live owner thesis
  const invalidation = agent && !("invalidation" in d) ? row.invalidation : str(d.invalidation);
  const changed = row.thesis !== text || row.invalidation !== invalidation;
  return {
    ...row,
    thesis: text,
    invalidation,
    core_changed_at: changed ? ctx.time(e, "core_changed_at") : row.core_changed_at,
    updated_at: now,
    draft: agent ? row.draft : 0,
  };
}

function marketView(e: FoldEvent, ctx: FoldContext, row: Row | undefined): Row | undefined {
  if (row === undefined || row.rejected_at !== null) return undefined; // needs a live thesis
  const d = e.data;
  const assessment = str(d.assessment);
  const outlook = str(d.outlook);
  let sources: string | null = "sources" in d ? json(d.sources) : row.view_sources;
  if (assessment === null && outlook === null) sources = null; // a cleared view keeps no sources
  if (sources === "[]") sources = null;
  const same =
    row.assessment === assessment &&
    row.outlook === outlook &&
    canonical(row.view_sources) === canonical(sources);
  if (same) return undefined;
  const now = ctx.time(e, "updated_at");
  return {
    ...row,
    assessment,
    outlook,
    view_sources: sources,
    view_updated_at:
      assessment !== null || outlook !== null ? ctx.time(e, "view_updated_at") : null,
    updated_at: now,
  };
}

const canonical = (v: string | null) => (v === null ? null : canonicalJson(JSON.parse(v)));

export const topicThesesMaterializer: Materializer = {
  id: "investments.topic_theses",
  version: 1,
  tables: [table],
  handles: [
    "topicThesis.ownerSaved",
    "topicThesis.draftProposed",
    "topicThesis.rejected",
    "topicThesis.marketViewSet",
  ],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids)
      ctx.sql.write(table.name, "DELETE FROM inv_topic_theses WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const g = e.gid;
    ctx.members.add(g, g);
    const row = ctx.sql.get<Row>(
      `SELECT ${COLUMNS.join(", ")} FROM inv_topic_theses WHERE gid = ?`,
      g,
    );
    let next: Row | undefined;
    switch (e.type) {
      case "topicThesis.ownerSaved":
      case "topicThesis.draftProposed":
        next = write(e, ctx, row);
        break;
      case "topicThesis.rejected":
        if (row === undefined || row.rejected_at !== null) return;
        next = {
          ...row,
          rejected_at: ctx.time(e, "rejected_at"),
          updated_at: ctx.time(e, "updated_at"),
        };
        break;
      case "topicThesis.marketViewSet":
        next = marketView(e, ctx, row);
        break;
    }
    if (next !== undefined) save(ctx, g, next);
  },
};
