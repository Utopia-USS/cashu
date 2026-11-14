// The store channel, v5: the desktop renderer's store protocol (S53 `@cashu/store-react/protocol`
// v1) carried in `store` frames of a `ui` session. The message shapes are v1's, with two changes:
// values are JSON (codec.ts) instead of structured clones, and `run` carries an idempotency `key`
// (a ULID the client mints once per command). A lost reply is reconciled by a read-only same-key
// lookup; the client never resends a mutation automatically. Query
// replies carry the UI policy generation so a privacy transition cannot deliver a queued old value.
import { z } from "zod";

/** Bumped on any incompatible change of the store channel; both ends refuse another version. */
export const STORE_PROTOCOL_VERSION = 5;

const json = z.json();
const vault = z.string().regex(/^[0-9a-f]{32}$/);
const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(200);

/** A ULID (Crockford base32, 26 characters; `mintUlid` in @cashu/store). */
export const idempotencyKeySchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device") }),
  z.object({ kind: z.literal("vault"), vault }),
]);
export type StoreTarget = z.infer<typeof targetSchema>;

/** What crosses for an unexpected failure: its class name and message, never a stack or values. */
export const errorInfoSchema = z.object({
  name: z.string().max(200),
  message: z.string().max(2_000),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;

export const storeToHostSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("uiPolicy"), generation: id, privacy: z.boolean() }),
  z.object({
    t: z.literal("sub"),
    sid: id,
    generation: id,
    resume: z.boolean(),
    target: targetSchema,
    query: name,
    args: json,
  }),
  z.object({ t: z.literal("unsub"), sid: id }),
  z
    .object({
      t: z.literal("lookup"),
      rid: id,
      generation: id,
      key: idempotencyKeySchema,
      target: targetSchema,
      command: name,
    })
    .strict(),
  z.object({
    t: z.literal("run"),
    rid: id,
    generation: id,
    key: idempotencyKeySchema,
    target: targetSchema,
    command: name,
    input: json,
  }),
  z.object({
    t: z.literal("action"),
    rid: id,
    target: z.object({ kind: z.literal("vault"), vault }),
    action: name,
    input: json,
  }),
]);
export type StoreToHost = z.infer<typeof storeToHostSchema>;

export const runOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), value: json }).strict(),
  z.object({ kind: z.literal("refused"), reason: name }).strict(),
  z.object({ kind: z.literal("not_started"), reason: name }).strict(),
  z.object({ kind: z.literal("outcome_unknown"), attemptId: name.optional() }).strict(),
]);
export type RunOutcomeWire = z.infer<typeof runOutcomeSchema>;

export const storeToClientSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("ready"),
    protocol: z.literal(STORE_PROTOCOL_VERSION),
    vaults: z.array(vault),
  }),
  z.object({ t: z.literal("value"), sid: id, generation: id, value: json }),
  z.object({ t: z.literal("error"), sid: id, generation: id, error: errorInfoSchema }),
  z.object({
    t: z.literal("result"),
    rid: id,
    generation: id,
    outcome: runOutcomeSchema,
  }),
  z.object({ t: z.literal("lookupResult"), rid: id, generation: id, outcome: runOutcomeSchema }),
  z.object({ t: z.literal("failed"), rid: id, generation: id, error: errorInfoSchema }),
  z.object({
    t: z.literal("actionResult"),
    rid: id,
    result: z.discriminatedUnion("status", [
      z.object({ status: z.literal("completed"), value: json }),
      z.object({
        status: z.literal("refused"),
        reason: name,
        preparation: z.enum(["none", "retained"]),
      }),
      z.object({
        status: z.literal("outcome_unknown"),
        reason: z.enum(["interrupted", "unexpected_failure"]),
        attempt: z.object({ key: idempotencyKeySchema, command: name }).strict().optional(),
      }),
      z.object({
        status: z.literal("not_started"),
        reason: z.enum(["disconnected", "capability_unavailable", "pending_previous_attempt"]),
      }),
    ]),
  }),
]);
export type StoreToClient = z.infer<typeof storeToClientSchema>;

/** An error's crossing form: class name and message, truncated. */
export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return { name: error.name.slice(0, 200), message: error.message.slice(0, 2_000) };
  }
  return { name: "Error", message: "non-error thrown" };
}
