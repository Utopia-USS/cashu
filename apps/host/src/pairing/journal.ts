import type { SqlDriver } from "@cashu/store";
import type { UnstampedEvent } from "@cashu/sync";

const DDL = `CREATE TABLE IF NOT EXISTS host_pairing_attempts (
  session TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT UNIQUE NOT NULL,
  vault TEXT NOT NULL,
  device TEXT NOT NULL,
  sign_key TEXT NOT NULL,
  box_key TEXT NOT NULL,
  certificate TEXT NOT NULL,
  event TEXT NOT NULL,
  eid TEXT NOT NULL,
  digest TEXT NOT NULL,
  welcome TEXT NOT NULL,
  pages TEXT NOT NULL,
  phase TEXT NOT NULL,
  committed_at INTEGER,
  uid TEXT,
  touched_at INTEGER
) WITHOUT ROWID;`;

/** Columns added after the table first shipped (an existing private DB gets them on open). */
const ADDED_COLUMNS = [
  ["uid", "TEXT"],
  ["touched_at", "INTEGER"],
] as const;

const INVITE_DDL = `CREATE TABLE IF NOT EXISTS host_pairing_invites (
  session TEXT PRIMARY KEY NOT NULL,
  vault TEXT NOT NULL,
  operation_id TEXT UNIQUE NOT NULL,
  qr_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  device TEXT,
  sign_key TEXT,
  box_key TEXT
) WITHOUT ROWID;`;

export interface PairingInviteRecord {
  readonly session: string;
  readonly vault: string;
  readonly operationId: string;
  readonly qrDigest: string;
  readonly expiresAt: number;
  readonly device?: string;
  readonly signKey?: string;
  readonly boxKey?: string;
}

type InviteRow = {
  session: string;
  vault: string;
  operation_id: string;
  qr_digest: string;
  expires_at: number;
  device: string | null;
  sign_key: string | null;
  box_key: string | null;
};

function decodeInviteRow(row: InviteRow): PairingInviteRecord {
  return {
    session: row.session,
    vault: row.vault,
    operationId: row.operation_id,
    qrDigest: row.qr_digest,
    expiresAt: row.expires_at,
    ...(row.device === null ? {} : { device: row.device }),
    ...(row.sign_key === null ? {} : { signKey: row.sign_key }),
    ...(row.box_key === null ? {} : { boxKey: row.box_key }),
  };
}

export interface PairingAttempt {
  readonly session: string;
  readonly operationId: string;
  readonly vault: string;
  readonly device: string;
  readonly signKey: string;
  readonly boxKey: string;
  readonly certificate: string;
  readonly event: UnstampedEvent;
  readonly eid: string;
  readonly digest: string;
  readonly welcome: Uint8Array;
  readonly pages: readonly Uint8Array[];
  /**
   * `admitting`: every check passed and the joiner's relay membership is being written (the commit
   * point); `may_append`: the membership exists, the keyed device.added append is owed; `completed` /
   * `not_started`: terminal. A row past `admitting` is never downgraded to `not_started`.
   */
  readonly phase: PairingPhase;
  readonly committedAt?: number;
  /** The joiner's relay uid (rows written since the relay commit point). */
  readonly uid?: string;
  /** When the row last changed phase or its membership write ended (resolving `admitting`). */
  readonly touchedAt?: number;
}

export type PairingPhase = "admitting" | "may_append" | "completed" | "not_started";
const PHASES: readonly string[] = ["admitting", "may_append", "completed", "not_started"];
/** Phases that still owe a step (they block the vault's other writes). */
const LIVE = "('admitting','may_append')";

type Row = {
  session: string;
  operation_id: string;
  vault: string;
  device: string;
  sign_key: string;
  box_key: string;
  certificate: string;
  event: string;
  eid: string;
  digest: string;
  welcome: string;
  pages: string;
  phase: string;
  committed_at: number | null;
  uid: string | null;
  touched_at: number | null;
};

function decode(row: Row): PairingAttempt {
  if (!PHASES.includes(row.phase)) throw new Error("pairing_journal_invalid");
  const pages: unknown = JSON.parse(row.pages);
  if (!Array.isArray(pages) || !pages.every((page) => typeof page === "string"))
    throw new Error("pairing_journal_invalid");
  return {
    session: row.session,
    vault: row.vault,
    device: row.device,
    operationId: row.operation_id,
    signKey: row.sign_key,
    boxKey: row.box_key,
    certificate: row.certificate,
    event: JSON.parse(row.event) as UnstampedEvent,
    eid: row.eid,
    digest: row.digest,
    welcome: Buffer.from(row.welcome, "base64url"),
    pages: pages.map((page) => Buffer.from(page, "base64url")),
    phase: row.phase as PairingPhase,
    ...(row.committed_at === null ? {} : { committedAt: row.committed_at }),
    ...(row.uid === null ? {} : { uid: row.uid }),
    ...(row.touched_at === null ? {} : { touchedAt: row.touched_at }),
  };
}

/** Private, nonreplaceable pairing metadata under the existing host writer lease. */
export class PairingJournal {
  readonly #db: SqlDriver;
  constructor(db: SqlDriver) {
    this.#db = db;
    db.exec(DDL);
    db.exec(INVITE_DDL);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(host_pairing_attempts)")
        .all<{ name: string }>()
        .map((column) => column.name),
    );
    for (const [name, type] of ADDED_COLUMNS)
      if (!columns.has(name))
        db.exec(`ALTER TABLE host_pairing_attempts ADD COLUMN ${name} ${type}`);
  }

  invite(vault: string, session: string): PairingInviteRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM host_pairing_invites WHERE vault=? AND session=?")
      .get<InviteRow>(vault, session);
    return row ? decodeInviteRow(row) : undefined;
  }

  registerInvite(record: PairingInviteRecord): void {
    this.#db
      .prepare(`INSERT OR IGNORE INTO host_pairing_invites
      (session,vault,operation_id,qr_digest,expires_at) VALUES (?,?,?,?,?)`)
      .run(record.session, record.vault, record.operationId, record.qrDigest, record.expiresAt);
    const saved = this.invite(record.vault, record.session);
    if (
      !saved ||
      saved.operationId !== record.operationId ||
      saved.qrDigest !== record.qrDigest ||
      saved.expiresAt !== record.expiresAt ||
      saved.vault !== record.vault
    )
      throw new Error("pairing_invite_conflict");
  }

  bindJoiner(
    vault: string,
    session: string,
    input: {
      readonly device: string;
      readonly signKey: string;
      readonly boxKey: string;
    },
  ): void {
    this.#db
      .prepare(`UPDATE host_pairing_invites SET device=?,sign_key=?,box_key=?
      WHERE vault=? AND session=? AND device IS NULL`)
      .run(input.device, input.signKey, input.boxKey, vault, session);
    const saved = this.invite(vault, session);
    if (
      !saved ||
      saved.device !== input.device ||
      saved.signKey !== input.signKey ||
      saved.boxKey !== input.boxKey
    )
      throw new Error("pairing_invite_conflict");
  }

  /** Bound idle metadata; pending append attempts keep their original subject binding. */
  pruneInvites(vault: string, now: number): number {
    return this.#db
      .prepare(`DELETE FROM host_pairing_invites
        WHERE vault=? AND expires_at<? AND NOT EXISTS (
          SELECT 1 FROM host_pairing_attempts a
          WHERE a.vault=host_pairing_invites.vault AND a.session=host_pairing_invites.session
            AND a.phase IN ${LIVE}
        )`)
      .run(vault, now - 24 * 60 * 60 * 1000).changes;
  }

  get(vault: string, session: string): PairingAttempt | undefined {
    const row = this.#db
      .prepare("SELECT * FROM host_pairing_attempts WHERE vault=? AND session=?")
      .get<Row>(vault, session);
    return row ? decode(row) : undefined;
  }

  forDevice(vault: string, device: string): PairingAttempt | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM host_pairing_attempts WHERE vault=? AND device=? AND phase='completed' ORDER BY committed_at DESC LIMIT 1",
      )
      .get<Row>(vault, device);
    return row ? decode(row) : undefined;
  }

  forOperation(vault: string, operationId: string): PairingAttempt | undefined {
    const row = this.#db
      .prepare("SELECT * FROM host_pairing_attempts WHERE vault=? AND operation_id=?")
      .get<Row>(vault, operationId);
    return row ? decode(row) : undefined;
  }

  /** Rows that still owe a step (`admitting`, `may_append`). */
  pending(vault: string): readonly PairingAttempt[] {
    return this.#db
      .prepare(`SELECT * FROM host_pairing_attempts WHERE vault=? AND phase IN ${LIVE}`)
      .all<Row>(vault)
      .map(decode);
  }

  prepare(attempt: PairingAttempt): PairingAttempt {
    this.#db
      .prepare(`INSERT OR IGNORE INTO host_pairing_attempts
      (session,operation_id,vault,device,sign_key,box_key,certificate,event,eid,digest,welcome,pages,phase,uid,touched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        attempt.session,
        attempt.operationId,
        attempt.vault,
        attempt.device,
        attempt.signKey,
        attempt.boxKey,
        attempt.certificate,
        JSON.stringify(attempt.event),
        attempt.eid,
        attempt.digest,
        Buffer.from(attempt.welcome).toString("base64url"),
        JSON.stringify(attempt.pages.map((page) => Buffer.from(page).toString("base64url"))),
        attempt.phase === "admitting" ? "admitting" : "may_append",
        attempt.uid ?? null,
        attempt.touchedAt ?? null,
      );
    const saved = this.get(attempt.vault, attempt.session);
    if (
      !saved ||
      saved.operationId !== attempt.operationId ||
      saved.vault !== attempt.vault ||
      saved.device !== attempt.device ||
      saved.digest !== attempt.digest ||
      saved.eid !== attempt.eid ||
      saved.signKey !== attempt.signKey ||
      saved.boxKey !== attempt.boxKey ||
      saved.certificate !== attempt.certificate ||
      saved.uid !== attempt.uid ||
      JSON.stringify(saved.event) !== JSON.stringify(attempt.event) ||
      !Buffer.from(saved.welcome).equals(Buffer.from(attempt.welcome)) ||
      saved.pages.length !== attempt.pages.length ||
      saved.pages.some(
        (page, index) => !Buffer.from(page).equals(Buffer.from(attempt.pages[index]!)),
      )
    )
      throw new Error("pairing_attempt_conflict");
    return saved;
  }

  /**
   * Moves a live row on: `admitting` -> `may_append` (the membership exists) or `not_started` (it
   * provably does not); `may_append` (or `admitting`, whose append landed) -> `completed`. A row past
   * `admitting` never goes back to `not_started`.
   */
  mark(
    vault: string,
    session: string,
    phase: Exclude<PairingPhase, "admitting">,
    now: number,
  ): void {
    const from = phase === "completed" ? LIVE : "('admitting')";
    const result = this.#db
      .prepare(`UPDATE host_pairing_attempts
      SET phase=?, committed_at=CASE WHEN ? IN ('completed','not_started') THEN ? ELSE committed_at END,
        touched_at=? WHERE vault=? AND session=? AND phase IN ${from}`)
      .run(phase, phase, now, now, vault, session);
    if (result.changes !== 1) throw new Error("pairing_attempt_changed");
  }

  /** Records that an `admitting` row's membership write ended without a known outcome. */
  touch(vault: string, session: string, now: number): void {
    this.#db
      .prepare(`UPDATE host_pairing_attempts SET touched_at=?
      WHERE vault=? AND session=? AND phase='admitting'`)
      .run(now, vault, session);
  }

  /** Expire only sealed response bytes; retain subject, EID, digest and terminal proof forever. */
  pruneReceipts(vault: string, now: number): number {
    return this.#db
      .prepare(`UPDATE host_pairing_attempts SET welcome='', pages='[]'
      WHERE vault=? AND phase IN ('completed','not_started') AND committed_at<? AND welcome<>''`)
      .run(vault, now - 24 * 60 * 60 * 1000).changes;
  }
}
