// Research signals inside a command batch (Python `research/signals.py` `sync` / `reopen_dismissed`):
// one signal per instrument, segment or (old) theme and ISO week of storing; a qualifying note
// creates it or joins it (refresh, or escalate when the severity goes up), the lead note shows; when
// no note qualifies any more the open signal resolves with `closed_reason` + `previous_status`.
//
// Emitters (events.md 8.7): `signal.opened` / `refreshed` / `escalated` for `research:` keys come from
// the device the research note is written on (no lease), `signal.closed {note_dismissed}` and
// `signal.reopened {note_restored}` from any device, `signal.closed {notes_expired}` from the lease
// holder (housekeeping). Python's reconciliation for one key is inlined: a fired candidate with an
// open signal escalates when its severity is higher (reactivating an acknowledged one), else
// refreshes; without one it opens (research rules have no cooldown); an open signal without a
// candidate resolves.
//
// The batch's own changes are not in the view yet, so the caller passes them as `overlay` (notes it
// adds or changes) and `open` (the episode a reopen of the same batch brings back).
import type { UiLang } from "@cashu/domain/core";
import { research, type SignalSeverity, severityRank } from "@cashu/domain/investments";
import type { CommandContext } from "../../command.js";
import { openSignalOfKey, type SignalView, signalByGid } from "../queries/signals.js";
import { weekNoteRows } from "./queries.js";
import {
  instantEvent,
  noteRanks,
  type ResearchNote,
  signalRecord,
  viewInstantOrNull,
} from "./rows.js";

type Instant = research.Instant;

export interface SyncResult {
  /** The signal episode of the key after the batch (null when there is none). */
  readonly signal: string | null;
  readonly created: boolean;
  readonly escalated: boolean;
  readonly resolved: boolean;
  /** The caller's device notifies (a new or escalated signal whose severity the policy names). */
  readonly notified: boolean;
}

export const NO_SYNC: SyncResult = {
  signal: null,
  created: false,
  escalated: false,
  resolved: false,
  notified: false,
};

export interface SyncOptions {
  readonly now: Instant;
  readonly lang: UiLang;
  /** Severities that notify at once (`notifyPolicy`). */
  readonly notify: ReadonlySet<string>;
  /** `payload.closed_reason` of a resolve (Python `reason`, default `notes_expired`). */
  readonly reason?: string;
  /** Notes this batch adds or changes, by gid (they replace the view's rows). */
  readonly overlay?: ReadonlyMap<string, ResearchNote>;
  /** The key's open episode as this batch leaves it, when the batch reopened it. */
  readonly open?: SignalView;
}

/** The notes of `key`'s week as the batch leaves them, in fold order (overlay rows last). */
function weekNotes(
  ctx: CommandContext,
  key: string,
  overlay: ReadonlyMap<string, ResearchNote>,
): ResearchNote[] {
  const rows = weekNoteRows(ctx.read, key).map((n) => overlay.get(n.gid) ?? n);
  const seen = new Set(rows.map((n) => n.gid));
  for (const n of overlay.values()) if (!seen.has(n.gid)) rows.push(n);
  return rows;
}

/** Python `sync`: bring the research signal of `key` in line with its notes. */
export function syncResearchSignal(ctx: CommandContext, key: string, o: SyncOptions): SyncResult {
  const overlay = o.overlay ?? new Map<string, ResearchNote>();
  const all = weekNotes(ctx, key, overlay);
  const ranks = noteRanks(all);
  const byRank = new Map([...ranks].map(([g, r]) => [r, g]));
  const records = all.map((n) => signalRecord(n, ranks.get(n.gid) as number));
  const mine = all.filter(
    (_, i) => research.noteKey(records[i] as research.ResearchNoteRecord) === key,
  );
  const mineRecords = mine.map((n) => signalRecord(n, ranks.get(n.gid) as number));
  const open = o.open ?? openSignalOfKey(ctx.read, key);
  const candidate = research.candidateFor(key, mineRecords, o.now, o.lang);
  if (candidate === null && open === undefined) return NO_SYNC;
  const seenAt = instantEvent(o.now);

  if (candidate === null) {
    const s = open as SignalView;
    const reason = o.reason ?? research.CLOSED_EXPIRED;
    ctx.emit("signal.closed", s.gid, {
      status: "resolved",
      reason,
      run: null,
      payloadSet: { closed_reason: reason, previous_status: s.status },
      stamps: { closed_at: seenAt },
    });
    return { ...NO_SYNC, signal: s.gid, resolved: true };
  }

  // The payload names notes by gid (gid.md 6): ranks back to gids.
  const toGid = (v: unknown) => (typeof v === "number" ? (byRank.get(v) ?? null) : v);
  const payload = {
    ...candidate.payload,
    note_id: toGid(candidate.payload.note_id),
    note_ids: (candidate.payload.note_ids as unknown[]).map(toGid),
  };
  const fields = {
    severity: candidate.severity,
    message: candidate.message,
    payload,
    ruleId: candidate.ruleId,
    kind: candidate.kind,
    polarity: candidate.polarity,
    instrument: candidate.instrumentId,
    account: null,
  };
  let episode: string;
  let created = false;
  let escalated = false;
  if (open === undefined) {
    episode = ctx.newGid();
    created = true;
    ctx.emit("signal.opened", episode, {
      ruleId: candidate.ruleId,
      kind: candidate.kind,
      dedupKey: key,
      severity: candidate.severity,
      polarity: candidate.polarity,
      message: candidate.message,
      instrument: candidate.instrumentId,
      account: null,
      payload,
      run: null,
      stamps: { first_seen_at: seenAt, last_seen_at: seenAt },
    });
  } else {
    episode = open.gid;
    const higher =
      severityRank(candidate.severity as SignalSeverity) >
      severityRank(open.severity as SignalSeverity);
    if (higher) {
      escalated = true;
      ctx.emit("signal.escalated", episode, {
        ...fields,
        reactivate: open.status === "acknowledged",
        run: null,
        seenAt,
      });
    } else {
      ctx.emit("signal.refreshed", episode, { ...fields, run: null, seenAt });
    }
  }
  // Every qualifying note remembers the episode (the lead note's kind may change within the week).
  for (const lead of research.leadNotes(mineRecords, o.now)) {
    const note = mine.find((n) => ranks.get(n.gid) === lead.id) as ResearchNote;
    if (note.signal !== episode) ctx.emit("note.signalLinked", note.gid, { signal: episode });
  }
  const snoozed =
    open !== undefined &&
    open.snoozedUntil !== null &&
    (viewInstantOrNull(open.snoozedUntil) as Instant) > o.now;
  const notified =
    (created && o.notify.has(candidate.severity)) ||
    (escalated && o.notify.has(candidate.severity) && !snoozed);
  return { signal: episode, created, escalated, resolved: false, notified };
}

/**
 * Python `reopen_dismissed`: the signal a dismissal resolved comes back (same row) when it closed
 * within `window` and no other signal of its key is open. Returns the episode as reopened (its
 * status the one before the dismissal) for the batch's later sync, else undefined.
 */
export function reopenDismissed(
  ctx: CommandContext,
  note: ResearchNote,
  now: Instant,
  window: bigint,
): SignalView | undefined {
  if (note.signal === null) return undefined;
  const s = signalByGid(ctx.read, note.signal);
  if (
    s === undefined ||
    s.status !== "resolved" ||
    s.payload.closed_reason !== research.CLOSED_DISMISSED ||
    s.closedAt === null ||
    now - (viewInstantOrNull(s.closedAt) as Instant) > window ||
    openSignalOfKey(ctx.read, s.dedupKey) !== undefined
  ) {
    return undefined;
  }
  ctx.emit("signal.reopened", s.gid, {
    reason: "note_restored",
    payloadUnset: ["closed_reason", "previous_status"],
  });
  const previous = s.payload.previous_status;
  const { closed_reason: _c, previous_status: _p, ...payload } = s.payload;
  return {
    ...s,
    status: previous === "acknowledged" ? "acknowledged" : "active",
    closedAt: null,
    payload,
  };
}
