// Executable reference semantics for the investments tables S25 folds (events.md 6.4, 8.5-8.10 with
// the S25 deltas; S25 spec section 4): a pure function of the SET of events, sorted by (hlc, eid),
// duplicates by eid ignored, invalid deterministic gids parked (7.10), FWW + causal suppression
// (6.6), identity resolution over the whole set (6.4). It returns the public rows exactly as the
// store's view holds them (column names, reference columns as the referenced gid, timestamps in the
// view's naive-UTC text, JSON columns parsed), so the store's materializers can be compared table by
// table. Not incremental on purpose. Signals, watchlist, overrides and valuations are modelled in
// fold.ts. Test oracle only: imports nothing from the store.
import { detPartsOf } from "../det-parts.js";
import { claimAllowed } from "../identity.js";
import type { RefDet, RefEvent } from "./fold.js";

type Row = Record<string, unknown>;
export type InvRefView = Record<(typeof INV_REF_TABLES)[number], Row[]>;

/** The public tables this reference models. */
export const INV_REF_TABLES = [
  "inv_instruments",
  "inv_instrument_aliases",
  "inv_account_settings",
  "inv_import_batches",
  "inv_transactions",
  "inv_transaction_members",
  "inv_position_snapshots",
  "inv_instrument_renames",
  "inv_strategy_versions",
  "inv_rule_runs",
  "alerts",
  "inv_theses",
  "inv_topic_theses",
  "inv_planned_deposits",
  "research_runs",
  "research_notes",
  "reviews",
] as const;

const TOPIC_DRAFT_COOLDOWN_MS = 90 * 86_400_000;
const FWW = new Set([
  "plannedDeposit.cancelled",
  "plannedDeposit.booked",
  // Proposal decisions: an investments row caused by a losing approval is suppressed (6.6).
  "proposal.approved",
  "proposal.rejected",
  "proposal.failed",
]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Event timestamp -> the view's text (`YYYY-MM-DD HH:MM:SS.ffffff`). */
function viewTs(ts: string): string;
function viewTs(ts: string | null): string | null;
function viewTs(ts: string | null): string | null {
  if (ts === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(ts);
  if (!m) throw new RangeError(`not an event timestamp: ${ts}`);
  return `${m[1]} ${m[2]}.${(m[3] ?? "").padEnd(6, "0")}`;
}

const stampsOf = (e: RefEvent) => e.data.stamps as Record<string, string | null> | undefined;

/** Domain time (events.md 4.4): the stamp, else the explicit payload value, else `at`. */
function time(e: RefEvent, column: string, explicit?: unknown): string {
  return viewTs(stampsOf(e)?.[column] ?? str(explicit) ?? e.at);
}

/** A nullable timestamp column: a present stamp (null included), else the payload value, else null. */
function maybeTime(e: RefEvent, column: string, explicit: unknown): string | null {
  const s = stampsOf(e);
  if (s !== undefined && column in s) return viewTs(s[column] ?? null);
  return viewTs(str(explicit));
}

const hasStamp = (e: RefEvent, column: string) => {
  const s = stampsOf(e);
  return s !== undefined && column in s;
};

function ordered(events: readonly RefEvent[], det: RefDet): RefEvent[] {
  const byEid = new Map<string, RefEvent>();
  for (const e of events) if (!byEid.has(e.eid)) byEid.set(e.eid, e);
  return [...byEid.values()]
    .filter((e) => {
      const p = detPartsOf(e.type, e.data);
      return p === undefined || det(p.table, p.parts) === e.gid;
    })
    .sort((a, b) =>
      a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0,
    );
}

function applied(evs: readonly RefEvent[]): RefEvent[] {
  const present = new Map(evs.map((e) => [e.eid, e]));
  const decided = new Set<string>();
  const losers = new Set<string>();
  for (const e of evs) {
    if (!FWW.has(e.type)) continue;
    if (decided.has(e.gid)) losers.add(e.eid);
    else decided.add(e.gid);
  }
  // Causal revocation (events.md 6.6, S31c): a later `proposal.applyFailed` of the approval's gid.
  const index = new Map(evs.map((e, i) => [e.eid, i]));
  const revoked = (c: RefEvent): boolean =>
    c.type === "proposal.approved" &&
    evs.some(
      (r) =>
        r.type === "proposal.applyFailed" &&
        r.gid === c.gid &&
        (index.get(r.eid) ?? -1) > (index.get(c.eid) ?? -1),
    );
  const memo = new Map<string, boolean>();
  const ok = (e: RefEvent): boolean => {
    const known = memo.get(e.eid);
    if (known !== undefined) return known;
    let r = !losers.has(e.eid);
    if (r && e.cause !== undefined) {
      const c = present.get(e.cause);
      r = c !== undefined && ok(c) && !revoked(c);
    }
    memo.set(e.eid, r);
    return r;
  };
  return evs.filter(ok);
}

/** Union-find in fold order: a claim of a held key folds the claimer into the holder; merges. */
class UnionFind {
  readonly #parent = new Map<string, string>();
  readonly #owner = new Map<string, string>();
  find(g: string): string {
    let r = g;
    for (let p = this.#parent.get(r); p !== undefined && p !== r; p = this.#parent.get(r)) r = p;
    return r;
  }
  #union(from: string, into: string): void {
    const a = this.find(from);
    const b = this.find(into);
    if (a !== b) this.#parent.set(a, b);
  }
  claim(g: string, key: string): void {
    const owner = this.#owner.get(key);
    if (owner === undefined) this.#owner.set(key, g);
    else this.#union(g, owner);
  }
  merge(source: string, target: string): void {
    this.#union(source, target);
  }
}

const byGid = (rows: Iterable<Row>): Row[] =>
  [...rows].sort((a, b) => (String(a.gid) < String(b.gid) ? -1 : 1));

export function materializeInvestments(input: readonly RefEvent[], det: RefDet): InvRefView {
  const evs = applied(ordered(input, det));
  // Identity over the whole set (only `ext:` account keys matter here; IBAN claims follow N2).
  const accounts = new UnionFind();
  const instruments = new UnionFind();
  for (const e of evs) {
    if (e.type === "account.opened" || e.type === "account.identified") {
      for (const k of (e.data.keys as string[] | undefined) ?? []) {
        if (claimAllowed(k, e.data.iban)) accounts.claim(e.gid, k);
      }
    } else if (e.type === "instrument.aliasAdded") {
      instruments.claim(String(e.data.instrument), `${e.data.namespace}:${e.data.value}`);
    } else if (e.type === "instrument.merged") {
      instruments.merge(String(e.data.source), String(e.data.target));
    }
  }
  const acc = (g: unknown) => (typeof g === "string" ? accounts.find(g) : null);
  const inst = (g: unknown) => (typeof g === "string" ? instruments.find(g) : null);
  const ord = (e: RefEvent) => e.hlc + e.eid;

  // inv_instruments + aliases
  const creates = new Map<string, { ord: string; data: Row; created: string; at: string }>();
  const fieldRegs = new Map<string, Map<string, { value: unknown; ord: string; at: string }>>();
  const aliases = new Map<string, Row>();
  // account settings, import batches, transactions, snapshots, renames
  const settings = new Map<string, Row>();
  const batches = new Map<string, Row>();
  const txns = new Map<string, Row>();
  const txnMembers = new Map<string, string>(); // member gid -> row key
  const snapshots = new Map<string, Row>();
  const renames = new Map<string, Row>();
  // strategy, runs, alerts, theses, topics, planned, research, reviews
  const versions: Row[] = [];
  const runs = new Map<string, Row>();
  const alerts = new Map<string, Row & { owner: string; triggered: boolean }>();
  const theses = new Map<string, Row>();
  const thesisTombs = new Set<string>();
  const topics = new Map<string, Row>();
  const planned = new Map<string, Row>();
  const bookedTxns = new Set<string>();
  const researchRuns = new Map<string, Row>();
  const notes = new Map<string, Row>();
  const reviews = new Map<string, Row>();
  const reviewTombs = new Set<string>();

  const INSTRUMENT_FIELDS: Record<string, string> = {
    name: "name",
    currency: "currency",
    assetClass: "asset_class",
    symbol: "symbol",
    isin: "isin",
    mic: "mic",
    region: "region",
    sector: "sector",
    tags: "tags",
    needsClassification: "needs_classification",
    valuationMode: "valuation_mode",
    status: "status",
  };

  for (const e of evs) {
    const d = e.data;
    switch (e.type) {
      case "instrument.created":
        if (!creates.has(e.gid)) {
          creates.set(e.gid, {
            ord: ord(e),
            data: d,
            created: time(e, "created_at"),
            at: time(e, "updated_at"),
          });
        }
        break;
      case "instrument.updated": {
        const root = instruments.find(e.gid);
        const regs = fieldRegs.get(root) ?? new Map();
        for (const f of Object.keys(INSTRUMENT_FIELDS)) {
          if (f in d) regs.set(f, { value: d[f] ?? null, ord: ord(e), at: time(e, "updated_at") });
        }
        fieldRegs.set(root, regs);
        break;
      }
      case "instrument.aliasAdded": {
        const held = aliases.get(e.gid);
        if (held === undefined) {
          aliases.set(e.gid, {
            gid: e.gid,
            instrument_id: inst(d.instrument),
            namespace: d.namespace,
            value: d.value,
            guessed: d.guessed === true ? 1 : 0,
            created_at: time(e, "created_at"),
          });
        } else if (d.guessed !== true) {
          held.guessed = 0; // any confirming claim confirms the alias (events.md 8.6)
        }
        break;
      }

      case "invAccount.settingsSet": {
        const key = String(acc(d.account));
        const row = settings.get(key) ?? {
          gid: e.gid,
          account_id: key,
          wrapper: "regular",
          importer: null,
          mapping_yaml: null,
          created_at: time(e, "created_at"),
        };
        if ("wrapper" in d) row.wrapper = str(d.wrapper) ?? "regular";
        if ("importer" in d) row.importer = str(d.importer);
        if ("mappingYaml" in d) row.mapping_yaml = str(d.mappingYaml);
        row.updated_at = time(e, "updated_at");
        settings.set(key, row);
        break;
      }
      case "invImport.recorded": {
        if (batches.has(e.gid)) break;
        const archive = d.archive as { sha256: string; ext: string } | undefined;
        batches.set(e.gid, {
          gid: e.gid,
          account_id: acc(d.account),
          importer: d.importer,
          broker: d.broker,
          file_name: d.fileName,
          file_sha256: d.fileSha256,
          archive_path: archive ? `${archive.sha256}.${archive.ext}` : null,
          txn_count: d.txnCount,
          duplicate_count: d.duplicateCount,
          position_count: d.positionCount,
          rename_count: d.renameCount,
          status_change_count: d.statusChangeCount,
          instrument_count: d.instrumentCount,
          correction_count: d.correctionCount,
          warnings: d.warnings,
          created_at: time(e, "created_at"),
        });
        break;
      }
      case "invTxn.imported": {
        const key = `${acc(d.account)}|${d.dedupHash}`;
        txnMembers.set(e.gid, key);
        if (txns.has(key)) break;
        txns.set(key, {
          gid: e.gid,
          account_id: acc(d.account),
          type: d.type,
          trade_date: d.tradeDate,
          settle_date: d.settleDate ?? null,
          instrument_id: inst(d.instrument),
          quantity: d.quantity ?? null,
          price: d.price ?? null,
          currency: d.currency,
          gross_amount: d.grossAmount,
          fee: d.fee,
          tax: d.tax,
          cash_amount: d.cashAmount,
          cash_currency: d.cashCurrency,
          fx_rate: d.fxRate ?? null,
          split_ratio: d.splitRatio ?? null,
          note: d.note ?? null,
          source: d.source,
          import_batch_id: str(d.batch),
          external_ref: d.externalRef ?? null,
          dedup_hash: d.dedupHash,
          created_at: time(e, "created_at", d.createdAt),
        });
        break;
      }
      case "position.snapshotImported":
      case "position.snapshotUpdated": {
        // Newest wins in fold order for the anchor's own gid (create or update, S31c); another
        // member gid (a merge collision) leaves the first applied member's row.
        const key = `${acc(d.account)}|${inst(d.instrument)}|${d.asOf}`;
        const held = snapshots.get(key);
        if (held !== undefined && held.gid !== e.gid) break;
        snapshots.set(key, {
          gid: e.gid,
          account_id: acc(d.account),
          instrument_id: inst(d.instrument),
          as_of: d.asOf,
          quantity: d.quantity,
          currency: d.currency,
          avg_price: d.avgPrice ?? null,
          market_value: d.marketValue ?? null,
          import_batch_id: str(d.batch),
          created_at: time(e, "created_at"),
        });
        break;
      }
      case "instrumentRename.recorded": {
        const from = inst(d.old);
        const to = inst(d.new);
        const key = `${d.date}|${from}|${to}`;
        if (from === to || renames.has(key)) break;
        renames.set(key, {
          gid: e.gid,
          date: d.date,
          old_instrument_id: from,
          new_instrument_id: to,
          note: d.note ?? null,
          import_batch_id: str(d.batch),
          created_at: time(e, "created_at"),
        });
        break;
      }

      case "strategy.versionSaved": {
        if (versions.some((v) => v.gid === e.gid)) break;
        const current = versions[versions.length - 1];
        if (current !== undefined && current.sha256 === d.sha256) break;
        versions.push({
          gid: e.gid,
          version: versions.length + 1,
          sha256: d.sha256,
          yaml_text: d.yamlText,
          md_text: d.mdText ?? null,
          state: d.state,
          issues: d.issues,
          created_at: time(e, "created_at"),
        });
        break;
      }
      case "ruleRun.finished":
        if (!runs.has(e.gid)) {
          runs.set(e.gid, {
            gid: e.gid,
            trigger: d.trigger,
            as_of: d.asOf,
            status: d.status,
            strategy_version_id: str(d.strategyVersion),
            stats: d.stats,
            errors: d.errors,
            report: d.report,
            started_at: time(e, "started_at", d.startedAt),
            finished_at: maybeTime(e, "finished_at", d.finishedAt),
          });
        }
        break;

      case "alert.created":
        if (!alerts.has(e.gid)) {
          alerts.set(e.gid, {
            gid: e.gid,
            instrument_id: inst(d.instrument),
            scope: d.scope,
            kind: d.kind,
            params: d.params,
            polarity: d.polarity,
            severity: d.severity,
            title: d.title,
            note: d.note ?? null,
            source: d.source,
            created_by: d.createdBy,
            status: "active",
            cooldown_days: d.cooldownDays ?? null,
            expires_at: maybeTime(e, "expires_at", d.expiresAt),
            snoozed_until: null,
            last_triggered_at: null,
            last_checked_at: null,
            last_value: null,
            created_at: time(e, "created_at"),
            updated_at: time(e, "updated_at"),
            deleted_at: null,
            tag: d.tag ?? null,
            owner: "active",
            triggered: false,
          });
        }
        break;
      case "alert.updated":
      case "alert.statusSet":
      case "alert.deleted":
      case "alert.restored":
      case "alert.evaluated": {
        const a = alerts.get(e.gid);
        if (a === undefined) break;
        if (e.type === "alert.updated") {
          const cols: Record<string, string> = {
            title: "title",
            note: "note",
            params: "params",
            polarity: "polarity",
            severity: "severity",
            cooldownDays: "cooldown_days",
            tag: "tag",
          };
          for (const [f, c] of Object.entries(cols)) if (f in d) a[c] = d[f] ?? null;
          if ("expiresAt" in d) a.expires_at = maybeTime(e, "expires_at", d.expiresAt);
          a.updated_at = time(e, "updated_at");
        } else if (e.type === "alert.statusSet") {
          a.owner = String(d.status);
          a.snoozed_until = viewTs(str(d.snoozedUntil));
          if (a.owner === "muted" || a.owner === "snoozed") a.triggered = false;
          a.updated_at = time(e, "updated_at");
        } else if (e.type === "alert.deleted") {
          a.deleted_at = time(e, "deleted_at");
        } else if (e.type === "alert.restored") {
          a.deleted_at = null;
          if (d.rearm === true) a.triggered = false;
          a.updated_at = time(e, "updated_at");
        } else {
          const checked = maybeTime(e, "last_checked_at", d.lastCheckedAt);
          const until = a.snoozed_until as string | null;
          if (a.owner === "snoozed" && checked !== null && until !== null && checked >= until) {
            a.owner = "active";
            a.snoozed_until = null;
          }
          a.triggered = d.triggered === true;
          if ("lastCheckedAt" in d) a.last_checked_at = checked;
          if ("lastValue" in d) a.last_value = str(d.lastValue);
          if ("lastTriggeredAt" in d) {
            a.last_triggered_at = maybeTime(e, "last_triggered_at", d.lastTriggeredAt);
          }
        }
        a.status =
          a.owner === "muted" || a.owner === "snoozed"
            ? a.owner
            : a.triggered
              ? "triggered"
              : "active";
        break;
      }

      case "thesis.created":
      case "thesis.updated":
      case "thesis.deleted": {
        if (thesisTombs.has(e.gid)) break;
        if (e.type === "thesis.deleted") {
          thesisTombs.add(e.gid);
          theses.delete(e.gid);
          break;
        }
        if (e.type === "thesis.created") {
          if (theses.has(e.gid)) break;
          const plan = str(d.exitPlan);
          theses.set(e.gid, {
            gid: e.gid,
            instrument_id: inst(d.instrument),
            entry_type: d.entryType,
            thesis: d.thesis,
            invalidation: d.invalidation ?? null,
            exit_plan: plan,
            size_plan: d.sizePlan ?? null,
            reviewed_at: maybeTime(e, "reviewed_at", null),
            created_at: time(e, "created_at"),
            updated_at: time(e, "updated_at"),
            core_changed_at: hasStamp(e, "core_changed_at")
              ? maybeTime(e, "core_changed_at", null)
              : time(e, "core_changed_at"),
            exit_plan_changed_at: hasStamp(e, "exit_plan_changed_at")
              ? maybeTime(e, "exit_plan_changed_at", null)
              : plan
                ? time(e, "exit_plan_changed_at")
                : null,
          });
          break;
        }
        const t = theses.get(e.gid);
        if (t === undefined) break;
        const cols: [string, string, boolean][] = [
          ["entryType", "entry_type", true],
          ["thesis", "thesis", true],
          ["invalidation", "invalidation", true],
          ["exitPlan", "exit_plan", false],
          ["sizePlan", "size_plan", false],
        ];
        for (const [f, c, core] of cols) {
          if (!(f in d)) continue;
          const v = str(d[f]);
          if (t[c] !== v) {
            if (core) t.core_changed_at = time(e, "core_changed_at");
            if (f === "exitPlan")
              t.exit_plan_changed_at = v ? time(e, "exit_plan_changed_at") : null;
          }
          t[c] = v;
        }
        if (d.reviewed === true) t.reviewed_at = time(e, "reviewed_at");
        t.updated_at = time(e, "updated_at");
        break;
      }

      case "topicThesis.ownerSaved":
      case "topicThesis.draftProposed": {
        const agent = e.type === "topicThesis.draftProposed";
        const row = topics.get(e.gid);
        const text = String(d.thesis);
        const now = time(e, "updated_at");
        const fresh = (): Row => ({
          gid: e.gid,
          segment: d.segment,
          thesis: text,
          invalidation: str(d.invalidation),
          draft: agent ? 1 : 0,
          created_by: agent ? "agent" : "owner",
          core_changed_at: time(e, "core_changed_at"),
          created_at: time(e, "created_at"),
          updated_at: now,
          rejected_at: null,
          assessment: null,
          outlook: null,
          view_updated_at: null,
          view_sources: null,
        });
        if (row === undefined) {
          topics.set(e.gid, fresh());
        } else if (row.rejected_at !== null) {
          const rejectedMs = Date.parse(
            `${String(row.rejected_at).replace(" ", "T").slice(0, 23)}Z`,
          );
          const nowMs = Date.parse(`${now.replace(" ", "T").slice(0, 23)}Z`);
          if (agent && nowMs < rejectedMs + TOPIC_DRAFT_COOLDOWN_MS) break;
          topics.set(e.gid, { ...fresh(), segment: row.segment });
        } else {
          if (agent && row.draft === 0) break;
          const inval = agent && !("invalidation" in d) ? row.invalidation : str(d.invalidation);
          if (row.thesis !== text || row.invalidation !== inval) {
            row.core_changed_at = time(e, "core_changed_at");
          }
          row.thesis = text;
          row.invalidation = inval;
          row.updated_at = now;
          if (!agent) row.draft = 0;
        }
        break;
      }
      case "topicThesis.rejected": {
        const row = topics.get(e.gid);
        if (row === undefined || row.rejected_at !== null) break;
        row.rejected_at = time(e, "rejected_at");
        row.updated_at = time(e, "updated_at");
        break;
      }
      case "topicThesis.marketViewSet": {
        const row = topics.get(e.gid);
        if (row === undefined || row.rejected_at !== null) break;
        const assessment = str(d.assessment);
        const outlook = str(d.outlook);
        let sources = "sources" in d ? (d.sources ?? null) : row.view_sources;
        if (assessment === null && outlook === null) sources = null;
        if (Array.isArray(sources) && sources.length === 0) sources = null;
        const same =
          row.assessment === assessment &&
          row.outlook === outlook &&
          JSON.stringify(row.view_sources) === JSON.stringify(sources);
        if (same) break;
        row.assessment = assessment;
        row.outlook = outlook;
        row.view_sources = sources;
        row.view_updated_at =
          assessment !== null || outlook !== null ? time(e, "view_updated_at") : null;
        row.updated_at = time(e, "updated_at");
        break;
      }

      case "plannedDeposit.created":
        if (!planned.has(e.gid)) {
          planned.set(e.gid, {
            gid: e.gid,
            account_id: acc(d.account),
            amount: d.amount,
            currency: d.currency,
            planned_date: d.plannedDate,
            note: d.note ?? null,
            status: "planned",
            booked_txn_id: null,
            booked_at: null,
            created_at: time(e, "created_at"),
            updated_at: time(e, "updated_at"),
          });
        }
        break;
      case "plannedDeposit.cancelled":
      case "plannedDeposit.booked": {
        const p = planned.get(e.gid);
        if (p === undefined || p.status !== "planned") break;
        if (e.type === "plannedDeposit.cancelled") {
          p.status = "cancelled";
        } else {
          const txn = String(d.txn);
          if (bookedTxns.has(txn)) break; // O10
          bookedTxns.add(txn);
          p.status = "booked";
          p.booked_txn_id = txn;
          p.booked_at = time(e, "booked_at");
        }
        p.updated_at = time(e, "updated_at");
        break;
      }

      case "researchRun.started":
        if (!researchRuns.has(e.gid)) {
          researchRuns.set(e.gid, {
            gid: e.gid,
            started_at: time(e, "started_at"),
            finished_at: null,
            status: "running",
            scope: d.scope,
            counts: {},
            created_by: d.createdBy,
          });
        }
        break;
      case "researchRun.finished": {
        const r = researchRuns.get(e.gid);
        if (r === undefined || r.status !== "running") break; // FWW on the run's status
        r.status = d.status;
        r.counts = d.counts;
        r.finished_at = time(e, "finished_at");
        break;
      }
      case "note.added":
        if (!notes.has(e.gid)) {
          notes.set(e.gid, {
            gid: e.gid,
            run_id: str(d.run),
            instrument_id: inst(d.instrument),
            theme: d.theme ?? null,
            kind: d.kind,
            polarity: d.polarity,
            strength: d.strength,
            thesis_relation: d.thesisRelation,
            thesis_field: d.thesisField ?? null,
            title: d.title,
            summary: d.summary,
            sources: d.sources,
            details: d.details ?? null,
            candidate_key: d.candidateKey ?? null,
            signal_id: str(d.signal),
            observed_at: time(e, "observed_at", d.observedAt),
            expires_at: time(e, "expires_at", d.expiresAt),
            created_by: d.createdBy,
            dismissed_at: maybeTime(e, "dismissed_at", null),
            cooldown_until: maybeTime(e, "cooldown_until", null),
            created_at: time(e, "created_at"),
            updated_at: time(e, "updated_at"),
            read_at: hasStamp(e, "read_at")
              ? maybeTime(e, "read_at", null)
              : d.createdBy === "user"
                ? time(e, "read_at")
                : null,
            segment: d.segment ?? null,
          });
        }
        break;
      case "note.read":
      case "note.dismissed":
      case "note.restored":
      case "note.candidateUpdated":
      case "note.signalLinked": {
        const n = notes.get(e.gid);
        if (n === undefined) break;
        if (e.type === "note.read") {
          if (n.read_at === null) n.read_at = time(e, "read_at");
        } else if (e.type === "note.dismissed") {
          if (n.dismissed_at !== null) break;
          n.dismissed_at = time(e, "dismissed_at");
          n.cooldown_until = maybeTime(e, "cooldown_until", d.cooldownUntil);
          n.updated_at = time(e, "updated_at");
        } else if (e.type === "note.restored") {
          if (n.dismissed_at === null) break;
          n.dismissed_at = null;
          n.cooldown_until = null;
          n.updated_at = time(e, "updated_at");
        } else if (e.type === "note.candidateUpdated") {
          n.instrument_id = inst(d.instrument);
          n.details = d.details ?? null;
          n.updated_at = time(e, "updated_at");
        } else {
          n.signal_id = str(d.signal);
        }
        break;
      }
      case "review.done":
      case "review.undone":
        if (reviewTombs.has(e.gid)) break;
        if (e.type === "review.undone") {
          reviewTombs.add(e.gid);
          reviews.delete(e.gid);
        } else if (!reviews.has(e.gid)) {
          reviews.set(e.gid, {
            gid: e.gid,
            module: d.module,
            done_at: time(e, "done_at", d.doneAt),
            notes: d.notes ?? null,
            stats: d.stats,
          });
        }
        break;
    }
  }

  // inv_instruments: one row per root holding a create; the base is the root's own create.
  const roots = new Map<string, string[]>();
  for (const g of creates.keys()) {
    const r = instruments.find(g);
    roots.set(r, [...(roots.get(r) ?? []), g]);
  }
  const instrumentRows: Row[] = [];
  for (const [root, members] of roots) {
    const made = members
      .map((g) => ({ g, ...(creates.get(g) as NonNullable<ReturnType<typeof creates.get>>) }))
      .sort((a, b) => (a.ord < b.ord ? -1 : 1));
    const base = made.find((c) => c.g === root) ?? (made[0] as (typeof made)[number]);
    const values: Row = { ...base.data };
    for (const c of made) {
      if (c === base) continue;
      for (const f of ["symbol", "isin", "mic"]) {
        if ((values[f] ?? null) === null && (c.data[f] ?? null) !== null) values[f] = c.data[f];
      }
    }
    let last = made.reduce((a, c) => (c.ord > a.ord ? c : a), base);
    for (const [f, r] of fieldRegs.get(root) ?? []) {
      values[f] = r.value;
      if (r.ord > last.ord) last = { ...last, ord: r.ord, at: r.at };
    }
    instrumentRows.push({
      gid: root,
      name: values.name,
      currency: values.currency,
      asset_class: values.assetClass,
      symbol: values.symbol ?? null,
      isin: values.isin ?? null,
      mic: values.mic ?? null,
      region: values.region ?? null,
      sector: values.sector ?? null,
      tags: values.tags ?? [],
      needs_classification: values.needsClassification === true ? 1 : 0,
      valuation_mode: values.valuationMode,
      status: values.status ?? "active",
      created_at: base.created,
      updated_at: last.at,
    });
  }

  const memberRows = [...txnMembers.entries()].map(([gid, key]) => ({
    gid,
    transaction_id: txns.get(key)?.gid,
  }));

  return {
    inv_instruments: byGid(instrumentRows),
    inv_instrument_aliases: byGid(aliases.values()),
    inv_account_settings: byGid(settings.values()),
    inv_import_batches: byGid(batches.values()),
    inv_transactions: byGid(txns.values()),
    inv_transaction_members: byGid(memberRows),
    inv_position_snapshots: byGid(snapshots.values()),
    inv_instrument_renames: byGid(renames.values()),
    inv_strategy_versions: byGid(versions),
    inv_rule_runs: byGid(runs.values()),
    alerts: byGid([...alerts.values()].map(({ owner: _o, triggered: _t, ...row }) => row)),
    inv_theses: byGid(theses.values()),
    inv_topic_theses: byGid(topics.values()),
    inv_planned_deposits: byGid(planned.values()),
    research_runs: byGid(researchRuns.values()),
    research_notes: byGid(notes.values()),
    reviews: byGid(reviews.values()),
  };
}
