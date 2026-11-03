/** Private, bounded notification click locators. An intent is never vault authority. */
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { WorkerNotification } from "../worker/contracts.js";

const MAX_ROWS = 1024;
const MAX_BYTES = 512 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const token = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.string().min(1).max(256);
const intentSchema = z
  .object({
    requestId: uuid,
    intentToken: token,
    vaultId: identity,
    kind: z.enum(["signal", "signalsSummary", "reviewDigest", "generic"]),
    signalId: identity.optional(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.kind === "signal") !== (row.signalId !== undefined))
      ctx.addIssue({ code: "custom", message: "signal target mismatch" });
    if (row.expiresAt <= row.createdAt || row.expiresAt - row.createdAt > RETENTION_MS)
      ctx.addIssue({ code: "custom", message: "invalid lifetime" });
  });
type NotificationIntent = z.infer<typeof intentSchema>;
const fileSchema = z
  .object({ version: z.literal(1), rows: z.array(intentSchema).max(MAX_ROWS) })
  .strict();

export interface NotificationIntentLedger {
  reserve(input: WorkerNotification): NotificationIntent;
  resolve(requestId: string, intentToken: string): NotificationIntent | null;
  consume(requestId: string, intentToken: string): boolean;
  revoke(requestId: string, intentToken: string): boolean;
}
const refuse = (): never => {
  throw new Error("notification_intents_unavailable");
};

export function privateNotificationIntents(
  directory: string,
  isCurrent: () => boolean,
  now: () => number,
): NotificationIntentLedger {
  const root = realpathSync.native(directory);
  if (lstatSync(directory).isSymbolicLink()) refuse();
  const pinned = lstatSync(root);
  const path = join(root, "notification-intents.json");
  const nofollow = constants.O_NOFOLLOW ?? 0;
  const check = () => {
    if (!isCurrent()) refuse();
    if (realpathSync.native(directory) !== root || lstatSync(directory).isSymbolicLink()) refuse();
    const info = lstatSync(root);
    if (
      !info.isDirectory() ||
      info.dev !== pinned.dev ||
      info.ino !== pinned.ino ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      refuse();
  };
  const regular = () => {
    try {
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        info.size > MAX_BYTES ||
        (process.getuid !== undefined && info.uid !== process.getuid())
      )
        refuse();
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return refuse();
    }
  };
  const load = (): NotificationIntent[] => {
    check();
    const info = regular();
    if (info === null) return [];
    const fd = openSync(path, constants.O_RDONLY | nofollow | (constants.O_NONBLOCK ?? 0));
    try {
      const current = fstatSync(fd);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.size > MAX_BYTES ||
        (current.mode & 0o077) !== 0
      )
        refuse();
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_BYTES) refuse();
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, size),
      );
      const parsed = fileSchema.safeParse(JSON.parse(decoded));
      if (!parsed.success) return refuse();
      const ids = new Set<string>(),
        tokens = new Set<string>();
      for (const row of parsed.data.rows) {
        if (ids.has(row.requestId) || tokens.has(row.intentToken)) refuse();
        ids.add(row.requestId);
        tokens.add(row.intentToken);
      }
      check();
      const final = regular();
      if (final?.dev !== info.dev || final.ino !== info.ino) refuse();
      return parsed.data.rows;
    } catch {
      return refuse();
    } finally {
      closeSync(fd);
    }
  };
  const save = (rows: readonly NotificationIntent[]) => {
    check();
    const record = { version: 1, rows };
    if (!fileSchema.safeParse(record).success) refuse();
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > MAX_BYTES) refuse();
    regular();
    const temporary = join(root, `.notification-intents-${randomUUID()}.tmp`);
    const fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | nofollow,
      0o600,
    );
    try {
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      check();
      regular();
      renameSync(temporary, path);
      const dir = openSync(root, constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      check();
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  check();
  const currentRows = () => load().filter((row) => row.expiresAt > now());
  const remove = (requestId: string, intentToken: string): boolean => {
    if (!uuid.safeParse(requestId).success || !token.safeParse(intentToken).success) return false;
    const rows = currentRows();
    const next = rows.filter(
      (row) => row.requestId !== requestId || row.intentToken !== intentToken,
    );
    if (next.length === rows.length) return false;
    save(next);
    return true;
  };
  return {
    reserve(input) {
      if (
        !identity.safeParse(input.vaultId).success ||
        (input.kind === "signal") !== (input.signalId !== undefined) ||
        (input.signalId !== undefined && !identity.safeParse(input.signalId).success)
      )
        refuse();
      const rows = currentRows();
      if (rows.length >= MAX_ROWS) refuse();
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) refuse();
      let row: NotificationIntent;
      do {
        row = {
          requestId: randomUUID(),
          intentToken: randomBytes(32).toString("hex"),
          vaultId: input.vaultId,
          kind: input.kind,
          ...(input.signalId === undefined ? {} : { signalId: input.signalId }),
          createdAt,
          expiresAt: createdAt + RETENTION_MS,
        };
      } while (
        rows.some((old) => old.requestId === row.requestId || old.intentToken === row.intentToken)
      );
      save([...rows, row]);
      return row;
    },
    resolve(requestId, intentToken) {
      if (!uuid.safeParse(requestId).success || !token.safeParse(intentToken).success) return null;
      return (
        currentRows().find(
          (row) => row.requestId === requestId && row.intentToken === intentToken,
        ) ?? null
      );
    },
    consume: remove,
    revoke: remove,
  };
}
