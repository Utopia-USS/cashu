/** Command-only transition facts. Deliberately absent from the public query barrel. */
import { gidOf, jsonObject, type Read } from "./shared.js";

export interface AlertMutation {
  readonly gid: string;
  readonly instrument: string | null;
  readonly scope: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly title: string;
  readonly note: string | null;
  readonly tag: string | null;
  readonly polarity: string;
  readonly severity: string;
  readonly source: string;
  readonly cooldownDays: number | null;
  readonly expiresAt: string | null;
  readonly deletedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly ownerStatus: string;
  readonly triggered: boolean;
}

export function alertMutation(read: Read, gid: string): AlertMutation | undefined {
  const row = read<
    Omit<AlertMutation, "params" | "triggered"> & { params: string; triggered: number }
  >(
    `SELECT a.gid, ${gidOf("a.instrument_id")} AS instrument, a.scope, a.kind, a.params,
     a.title, a.note, a.tag, a.polarity, a.severity, a.source, a.cooldown_days AS cooldownDays,
     a.expires_at AS expiresAt, a.deleted_at AS deletedAt, a.snoozed_until AS snoozedUntil,
     s.owner_status AS ownerStatus, s.triggered FROM alerts a
     JOIN fold_alert_state s ON s.gid = a.gid WHERE a.gid = ?`,
    gid,
  )[0];
  return row === undefined
    ? undefined
    : { ...row, params: jsonObject(row.params), triggered: row.triggered === 1 };
}
