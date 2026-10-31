// The store port protocol (desktop renderer <-> store process), validated with zod on both ends: the
// renderer is sandboxed and untrusted by the store process, and the store process's messages are
// checked before the UI acts on them. Queries and commands travel by id; the store process serves only
// the ones it registered. Values are `encodeValue`d (codec.ts); arguments and inputs are JSON.
import { z } from "zod";

/** Bumped on any incompatible change; both ends refuse another version. */
export const PROTOCOL_VERSION = 1;

const json = z.json();
/** Query arguments and command input as they cross the port. */
export type JsonValue = z.infer<typeof json>;

const vault = z.string().regex(/^[0-9a-f]{32}$/);
const id = z.number().int().nonnegative();
const name = z.string().min(1).max(200);

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device") }),
  z.object({ kind: z.literal("vault"), vault }),
]);

/** What crosses for an unexpected failure: its class name and message, never a stack or values. */
export const errorInfoSchema = z.object({
  name: z.string().max(200),
  message: z.string().max(2_000),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;

export const toHostSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), sid: id, target: targetSchema, query: name, args: json }),
  z.object({ t: z.literal("unsub"), sid: id }),
  z.object({ t: z.literal("run"), rid: id, target: targetSchema, command: name, input: json }),
]);
export type ToHost = z.infer<typeof toHostSchema>;

export const toClientSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("ready"),
    protocol: z.literal(PROTOCOL_VERSION),
    vaults: z.array(vault),
  }),
  z.object({ t: z.literal("value"), sid: id, value: z.unknown() }),
  z.object({ t: z.literal("error"), sid: id, error: errorInfoSchema }),
  z.object({
    t: z.literal("result"),
    rid: id,
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({ ok: z.literal(false), reason: z.string().max(200) }),
    ]),
  }),
  z.object({ t: z.literal("failed"), rid: id, error: errorInfoSchema }),
]);
export type ToClient = z.infer<typeof toClientSchema>;

/** An unexpected failure on the other side of the port, rethrown here (to the error boundary). */
export class RemoteStoreError extends Error {
  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = info.name;
  }
}

export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return { name: error.name.slice(0, 200), message: error.message.slice(0, 2_000) };
  }
  return { name: "Error", message: "non-error thrown" };
}
