// Signals and decisions (events.md 8.7, 6.5): the episode fold. "At most one open signal per dedup
// key" is keyed by the RESOLVED dedup key K (gid.md 5): a second `signal.opened` of an open K joins
// the open episode as an alias; events of any alias land on its episode. Decisions acknowledge the
// active episodes they link; undoing one (TOMB) returns them to active unless another live decision
// still links them. The public partial UNIQUE index on open keys mirrors Python's and makes a fold
// bug fail loudly instead of forking the view.
//
// Partitions: one per resolved key (`k:<K>`), one per decision (`d:<gid>`). A decision belongs to
// its own partition and to every linked episode's, so re-folds keep both consistent.
//
// S25 completion (spec 4.8): a refresh (and the alias path of an open) rewrites `rule_id`, `kind`,
// `polarity`, `instrument_id`, `account_id` when present (S25-F1) and sets `last_run_id` from `run`,
// null included (S25-F2); a close with `run` sets it too; `signal.closed.payloadSet` merges keys into
// the payload and `signal.reopened.payloadUnset` removes them (D-S3, S25-F3). The public TS-only table
// `inv_signal_aliases (gid, signal_id)` maps every signal gid to its episode row (D-S2), so a note's
// `signal_id` or a rule run's report naming an alias resolves in queries.
import { ACCOUNTS } from "../core/accounts.js";
import type { FoldContext, FoldEvent, Materializer } from "../engine/types.js";
import { restoreFloats } from "../events/v1/primitives.js";
import type { TableDef } from "../sql/ddl.js";
import type { SqlValue } from "../sql/driver.js";
import { sqlJson, viewTimestamp } from "../sql/values.js";
import { INSTRUMENTS } from "./instruments.js";

const signals: TableDef = {
  name: "inv_signals",
  columns: [
    { name: "rule_id", type: "TEXT", notNull: true },
    { name: "kind", type: "TEXT", notNull: true },
    { name: "dedup_key", type: "TEXT", notNull: true },
    { name: "severity", type: "TEXT", notNull: true },
    { name: "status", type: "TEXT", notNull: true },
    { name: "message", type: "TEXT", notNull: true },
    { name: "instrument_id", type: "INTEGER", ref: "inv_instruments" },
    { name: "account_id", type: "INTEGER", ref: "accounts" },
    { name: "payload", type: "TEXT", notNull: true, json: true },
    { name: "first_seen_at", type: "TEXT", notNull: true },
    { name: "last_seen_at", type: "TEXT", notNull: true },
    { name: "created_run_id", type: "INTEGER", ref: "inv_rule_runs" },
    { name: "last_run_id", type: "INTEGER", ref: "inv_rule_runs" },
    { name: "acknowledged_at", type: "TEXT" },
    { name: "closed_at", type: "TEXT" },
    { name: "polarity", type: "TEXT", notNull: true, default: "'neutral'" },
    { name: "snoozed_until", type: "TEXT" },
  ],
  indexes: [
    { columns: ["dedup_key"], unique: true, where: "status IN ('active', 'acknowledged')" },
    { columns: ["dedup_key"] },
  ],
};

const decisions: TableDef = {
  name: "inv_decisions",
  columns: [
    { name: "signal_id", type: "INTEGER", ref: "inv_signals" },
    { name: "instrument_id", type: "INTEGER", ref: "inv_instruments" },
    { name: "account_id", type: "INTEGER", ref: "accounts" },
    { name: "action", type: "TEXT", notNull: true },
    { name: "quantity", type: "TEXT" },
    { name: "price", type: "TEXT" },
    { name: "currency", type: "TEXT" },
    { name: "reason", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["signal_id"] }],
};

const decisionSignals: TableDef = {
  name: "inv_decision_signals",
  primaryKey: ["decision_id", "signal_id"],
  columns: [
    { name: "decision_id", type: "INTEGER", notNull: true, ref: "inv_decisions" },
    { name: "signal_id", type: "INTEGER", notNull: true, ref: "inv_signals" },
  ],
  indexes: [{ columns: ["signal_id"] }],
};

/** Public TS-only map: every signal gid -> its episode row (D-S2). */
const publicAliases: TableDef = {
  name: "inv_signal_aliases",
  columns: [{ name: "signal_id", type: "INTEGER", notNull: true, ref: "inv_signals" }],
  indexes: [{ columns: ["signal_id"] }],
};

/** Signal gid -> its episode (itself when it started one, the open episode it joined otherwise). */
const aliases: TableDef = {
  name: "fold_signal_aliases",
  primaryKey: ["gid"],
  internal: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "episode", type: "TEXT", notNull: true },
    { name: "partition", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["partition"] }, { columns: ["episode"] }],
};

/**
 * Episode registers the fold needs beyond the public row (the close reason). The payload keys Python
 * writes on a close come from `signal.closed.payloadSet` (D-S3), not from this register.
 */
const episodes: TableDef = {
  name: "fold_signal_episodes",
  primaryKey: ["gid"],
  internal: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "partition", type: "TEXT", notNull: true },
    { name: "closed_reason", type: "TEXT" },
  ],
  indexes: [{ columns: ["partition"] }],
};

const OPEN = "status IN ('active', 'acknowledged')";

/** A dedup key with its `i:` / `a:` gid parts replaced by their identity roots (gid.md 5). */
function resolveDedupKey(key: string, ctx: FoldContext): string {
  return key
    .split("|")
    .map((part) => {
      if (part.startsWith("i:")) return `i:${ctx.resolve(INSTRUMENTS, part.slice(2))}`;
      if (part.startsWith("a:")) return `a:${ctx.resolve(ACCOUNTS, part.slice(2))}`;
      return part;
    })
    .join("|");
}

const keyPartition = (k: string) => `k:${k}`;
const decisionPartition = (gid: string) => `d:${gid}`;

interface EpisodeRow {
  gid: string;
  id: number;
  dedup_key: string;
  status: string;
  snoozed_until: string | null;
}

function episodeOf(ctx: FoldContext, signal: string): EpisodeRow | undefined {
  const a = ctx.sql.get<{ episode: string }>(
    "SELECT episode FROM fold_signal_aliases WHERE gid = ?",
    signal,
  );
  if (!a) return undefined;
  return ctx.sql.get<EpisodeRow>(
    "SELECT gid, id, dedup_key, status, snoozed_until FROM inv_signals WHERE gid = ?",
    a.episode,
  );
}

function liveDecisionAt(ctx: FoldContext, episodeId: number): string | null {
  return (
    ctx.sql.get<{ at: string | null }>(
      `SELECT MAX(d.created_at) AS at FROM inv_decision_signals l JOIN inv_decisions d ON d.id = l.decision_id
       WHERE l.signal_id = ?`,
      episodeId,
    )?.at ?? null
  );
}

const refOrNull = (ctx: FoldContext, kind: string, v: unknown) =>
  typeof v === "string" ? ctx.id(ctx.resolve(kind, v)) : null;

const runOrNull = (ctx: FoldContext, v: unknown) => (typeof v === "string" ? ctx.id(v) : null);

function linkAlias(ctx: FoldContext, gid: string, episode: string, partition: string): void {
  ctx.sql.write(
    aliases.name,
    "INSERT OR REPLACE INTO fold_signal_aliases (gid, episode, partition) VALUES (?, ?, ?)",
    gid,
    episode,
    partition,
  );
  ctx.sql.write(
    publicAliases.name,
    "INSERT OR REPLACE INTO inv_signal_aliases (id, gid, signal_id) VALUES (?, ?, ?)",
    ctx.id(gid),
    gid,
    ctx.id(episode),
  );
}

/**
 * The refresh columns an event sets (S25-F1, F2): rule / kind / polarity / instrument / account when
 * present, `last_run_id` from `run` when present (null clears), severity / message / payload.
 */
function refreshSets(e: FoldEvent, ctx: FoldContext): [string[], SqlValue[]] {
  const d = e.data;
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (column: string, value: SqlValue) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if ("ruleId" in d) set("rule_id", String(d.ruleId));
  if ("kind" in d) set("kind", String(d.kind));
  if ("polarity" in d) set("polarity", String(d.polarity));
  if ("instrument" in d) set("instrument_id", refOrNull(ctx, INSTRUMENTS, d.instrument));
  if ("account" in d) set("account_id", refOrNull(ctx, ACCOUNTS, d.account));
  if ("run" in d) set("last_run_id", runOrNull(ctx, d.run));
  if ("severity" in d) set("severity", String(d.severity));
  if ("message" in d) set("message", String(d.message));
  if ("payload" in d) set("payload", sqlJson(restoreFloats(d.payload ?? {}, d.payloadFloats)));
  return [sets, params];
}

/** Rewrite the episode payload with keys merged in (`set`) or removed (`unset`). */
function patchPayload(
  ctx: FoldContext,
  gid: string,
  set: Readonly<Record<string, unknown>> | undefined,
  unset: readonly string[] | undefined,
): void {
  if (set === undefined && unset === undefined) return;
  const row = ctx.sql.get<{ payload: string }>(
    "SELECT payload FROM inv_signals WHERE gid = ?",
    gid,
  );
  const payload = { ...(JSON.parse(row?.payload ?? "{}") as Record<string, unknown>), ...set };
  for (const k of unset ?? []) delete payload[k];
  ctx.sql.write(
    signals.name,
    "UPDATE inv_signals SET payload = ? WHERE gid = ?",
    sqlJson(payload),
    gid,
  );
}

function setStatus(ctx: FoldContext, gid: string, status: string, ackAt: string | null): void {
  ctx.sql.write(
    signals.name,
    "UPDATE inv_signals SET status = ?, acknowledged_at = ? WHERE gid = ?",
    status,
    ackAt,
    gid,
  );
}

function applySignal(e: FoldEvent, ctx: FoldContext): void {
  const d = e.data;
  if (e.type === "signal.opened") {
    const key = resolveDedupKey(String(d.dedupKey), ctx);
    const partition = keyPartition(key);
    ctx.members.add(partition, e.gid);
    // CREATE: a signal gid is opened once; a second open of the same gid (a writer bug) is a no-op.
    // Its membership above still ties both partitions together for re-folds.
    if (ctx.sql.get("SELECT 1 FROM fold_signal_aliases WHERE gid = ?", e.gid)) return;
    const seen = ctx.time(e, "last_seen_at");
    const open = ctx.sql.get<{ gid: string }>(
      `SELECT gid FROM inv_signals WHERE dedup_key = ? AND ${OPEN}`,
      key,
    );
    if (open) {
      // B2: joins the open episode with refresh semantics (S25-F1, F2: the open's rule, kind,
      // polarity, instrument, account and run replace the episode's).
      linkAlias(ctx, e.gid, open.gid, partition);
      const [sets, params] = refreshSets(e, ctx);
      ctx.sql.write(
        signals.name,
        `UPDATE inv_signals SET ${sets.join(", ")}, last_seen_at = ? WHERE gid = ?`,
        ...params,
        seen,
        open.gid,
      );
      return;
    }
    linkAlias(ctx, e.gid, e.gid, partition);
    ctx.sql.write(
      episodes.name,
      "INSERT OR REPLACE INTO fold_signal_episodes (gid, partition, closed_reason) VALUES (?, ?, NULL)",
      e.gid,
      partition,
    );
    ctx.sql.write(
      signals.name,
      `INSERT INTO inv_signals (id, gid, rule_id, kind, dedup_key, severity, status, message, instrument_id,
         account_id, payload, first_seen_at, last_seen_at, created_run_id, last_run_id, polarity)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      String(d.ruleId),
      String(d.kind),
      key,
      String(d.severity),
      String(d.message),
      refOrNull(ctx, INSTRUMENTS, d.instrument),
      refOrNull(ctx, ACCOUNTS, d.account),
      sqlJson(restoreFloats(d.payload ?? {}, d.payloadFloats)), // events.md 4.3
      ctx.time(e, "first_seen_at"),
      seen,
      runOrNull(ctx, d.run),
      runOrNull(ctx, d.run),
      String(d.polarity ?? "neutral"),
    );
    return;
  }

  const ep = episodeOf(ctx, e.gid);
  if (!ep) return; // parked: its open is not held
  const isOpen = ep.status === "active" || ep.status === "acknowledged";
  switch (e.type) {
    case "signal.refreshed":
    case "signal.escalated": {
      if (!isOpen) return;
      const [sets, params] = refreshSets(e, ctx);
      ctx.sql.write(
        signals.name,
        `UPDATE inv_signals SET ${[...sets, "last_seen_at = ?"].join(", ")} WHERE gid = ?`,
        ...params,
        ctx.time(e, "last_seen_at", String(d.seenAt)),
        ep.gid,
      );
      if (e.type === "signal.escalated" && d.reactivate === true)
        setStatus(ctx, ep.gid, "active", null);
      return;
    }
    case "signal.closed": {
      if (!isOpen) return;
      ctx.sql.write(
        signals.name,
        "UPDATE inv_signals SET status = ?, closed_at = ? WHERE gid = ?",
        d.status === "expired" ? "expired" : "resolved",
        ctx.time(e, "closed_at"),
        ep.gid,
      );
      ctx.sql.write(
        episodes.name,
        "UPDATE fold_signal_episodes SET closed_reason = ? WHERE gid = ?",
        String(d.reason),
        ep.gid,
      );
      if ("run" in d) {
        ctx.sql.write(
          signals.name,
          "UPDATE inv_signals SET last_run_id = ? WHERE gid = ?",
          runOrNull(ctx, d.run),
          ep.gid,
        );
      }
      patchPayload(ctx, ep.gid, d.payloadSet as Record<string, unknown> | undefined, undefined);
      return;
    }
    case "signal.reopened": {
      const fits =
        (d.reason === "alert_restored" && ep.status === "expired") ||
        (d.reason === "note_restored" && ep.status === "resolved");
      if (!fits) return;
      const other = ctx.sql.get<{ gid: string }>(
        `SELECT gid FROM inv_signals WHERE dedup_key = ? AND ${OPEN}`,
        ep.dedup_key,
      );
      if (other) return; // another episode of the key is open
      const ackAt = liveDecisionAt(ctx, ep.id);
      ctx.sql.write(
        signals.name,
        "UPDATE inv_signals SET status = ?, acknowledged_at = ?, closed_at = NULL WHERE gid = ?",
        ackAt === null ? "active" : "acknowledged",
        ackAt,
        ep.gid,
      );
      ctx.sql.write(
        episodes.name,
        "UPDATE fold_signal_episodes SET closed_reason = NULL WHERE gid = ?",
        ep.gid,
      );
      patchPayload(ctx, ep.gid, undefined, d.payloadUnset as string[] | undefined);
      return;
    }
    case "signal.snoozed":
      ctx.sql.write(
        signals.name,
        "UPDATE inv_signals SET snoozed_until = ? WHERE gid = ?",
        viewTimestamp((d.until as string | null) ?? null),
        ep.gid,
      );
      return;
    case "signal.woken": {
      if (ep.snoozed_until !== viewTimestamp(String(d.until))) return; // M7 GUARD
      ctx.sql.write(
        signals.name,
        "UPDATE inv_signals SET snoozed_until = NULL WHERE gid = ?",
        ep.gid,
      );
      if (ep.status === "acknowledged") setStatus(ctx, ep.gid, "active", null);
      return;
    }
  }
}

function applyDecision(e: FoldEvent, ctx: FoldContext): void {
  const d = e.data;
  const decisionId = ctx.id(e.gid);
  if (e.type === "decision.recorded") {
    ctx.members.add(decisionPartition(e.gid), e.gid);
    const at = ctx.time(e, "created_at");
    const linked: EpisodeRow[] = [];
    for (const s of (d.signals as string[] | undefined) ?? []) {
      const ep = episodeOf(ctx, s);
      if (ep && !linked.some((x) => x.gid === ep.gid)) linked.push(ep);
    }
    ctx.sql.write(
      decisions.name,
      `INSERT OR IGNORE INTO inv_decisions (id, gid, signal_id, instrument_id, account_id, action, quantity,
         price, currency, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      decisionId,
      e.gid,
      linked[0]?.id ?? null,
      refOrNull(ctx, INSTRUMENTS, d.instrument),
      refOrNull(ctx, ACCOUNTS, d.account),
      String(d.action),
      (d.quantity as string | null) ?? null,
      (d.price as string | null) ?? null,
      (d.currency as string | null) ?? null,
      (d.reason as string | null) ?? null,
      at,
    );
    for (const ep of linked) {
      ctx.members.add(keyPartition(ep.dedup_key), e.gid);
      ctx.sql.write(
        decisionSignals.name,
        "INSERT OR IGNORE INTO inv_decision_signals (decision_id, signal_id) VALUES (?, ?)",
        decisionId,
        ep.id,
      );
      if (ep.status === "active") setStatus(ctx, ep.gid, "acknowledged", at);
    }
    return;
  }
  // decision.undone (TOMB): the decision leaves the view; its episodes lose the link.
  const links = ctx.sql.all<{ signal_id: number }>(
    "SELECT signal_id FROM inv_decision_signals WHERE decision_id = ?",
    decisionId,
  );
  ctx.sql.write(
    decisionSignals.name,
    "DELETE FROM inv_decision_signals WHERE decision_id = ?",
    decisionId,
  );
  ctx.sql.write(decisions.name, "DELETE FROM inv_decisions WHERE id = ?", decisionId);
  for (const { signal_id } of links) {
    const ep = ctx.sql.get<{ gid: string; status: string }>(
      "SELECT gid, status FROM inv_signals WHERE id = ?",
      signal_id,
    );
    if (ep?.status !== "acknowledged") continue;
    const ackAt = liveDecisionAt(ctx, signal_id);
    if (ackAt === null) setStatus(ctx, ep.gid, "active", null);
  }
}

export const signalsMaterializer: Materializer = {
  id: "investments.signals",
  version: 2,
  tables: [signals, decisions, decisionSignals, publicAliases, aliases, episodes],
  handles: [
    "signal.opened",
    "signal.refreshed",
    "signal.escalated",
    "signal.closed",
    "signal.reopened",
    "signal.snoozed",
    "signal.woken",
    "decision.recorded",
    "decision.undone",
  ],
  identity: [INSTRUMENTS, ACCOUNTS],
  partitions(e, ctx) {
    if (e.type === "signal.opened") {
      return [keyPartition(resolveDedupKey(String(e.data.dedupKey), ctx))];
    }
    if (e.type === "decision.recorded") {
      const out = new Set([decisionPartition(e.gid)]);
      for (const s of (e.data.signals as string[] | undefined) ?? []) {
        for (const p of ctx.members.partitionsOf(s)) out.add(p);
      }
      return [...out];
    }
    if (e.type === "decision.undone") {
      return [...new Set([decisionPartition(e.gid), ...ctx.members.partitionsOf(e.gid)])];
    }
    return ctx.members.partitionsOf(e.gid);
  },
  refs: (e) => (e.type === "decision.recorded" ? ((e.data.signals as string[]) ?? []) : []),
  clear(partitions, ctx) {
    for (const p of partitions) {
      if (p.startsWith("d:")) {
        const id = ctx.id(p.slice(2));
        ctx.sql.write(
          decisionSignals.name,
          "DELETE FROM inv_decision_signals WHERE decision_id = ?",
          id,
        );
        ctx.sql.write(decisions.name, "DELETE FROM inv_decisions WHERE id = ?", id);
        continue;
      }
      for (const { gid } of ctx.sql.all<{ gid: string }>(
        "SELECT gid FROM fold_signal_episodes WHERE partition = ?",
        p,
      )) {
        const id = ctx.id(gid);
        ctx.sql.write(
          decisionSignals.name,
          "DELETE FROM inv_decision_signals WHERE signal_id = ?",
          id,
        );
        ctx.sql.write(
          decisions.name,
          "UPDATE inv_decisions SET signal_id = NULL WHERE signal_id = ?",
          id,
        );
        ctx.sql.write(signals.name, "DELETE FROM inv_signals WHERE gid = ?", gid);
      }
      ctx.sql.write(episodes.name, "DELETE FROM fold_signal_episodes WHERE partition = ?", p);
      ctx.sql.write(
        publicAliases.name,
        "DELETE FROM inv_signal_aliases WHERE gid IN (SELECT gid FROM fold_signal_aliases WHERE partition = ?)",
        p,
      );
      ctx.sql.write(aliases.name, "DELETE FROM fold_signal_aliases WHERE partition = ?", p);
    }
  },
  apply(e, ctx) {
    if (e.type.startsWith("decision.")) applyDecision(e, ctx);
    else applySignal(e, ctx);
  },
};
