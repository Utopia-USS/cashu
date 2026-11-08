/** Versioned, bounded LAN envelope. Pairing payloads remain sealed by @cashu/sync. */

import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";

export const LAN_VERSION = 1;
export const LAN_PAIR_PATH = "/v1/pair/exchange";
export const LAN_PAIR_RESUME_PATH = "/v1/pair/resume";
export const LAN_CHALLENGE_PATH = "/v1/auth/challenge";
export const LAN_CARRIER_PATH = "/v1/carrier";
export const LAN_MAX_PAIR_BYTES = 4 * 1024 * 1024;
export const LAN_MAX_APPEND_BYTES = 72 * 1024 * 1024;
export const LAN_MAX_READ_BYTES = 72 * 1024 * 1024;
export const LAN_MAX_WIRE_BYTES = 100 * 1024 * 1024;

const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const b64 = z.string().regex(/^[A-Za-z0-9_-]*$/);

function canonicalIpv4(value: string, allowLoopback: boolean): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const bytes = parts.map(Number);
  if (bytes.some((part) => part > 255)) return false;
  const [a, b] = bytes;
  return (
    a === 10 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (allowLoopback && a === 127 && b === 0 && bytes[2] === 0 && bytes[3] === 1)
  );
}

export interface LanDescriptor {
  readonly v: 1;
  readonly ip: string;
  readonly port: number;
  /** SHA-256 of DER SPKI, lowercase hex. */
  readonly spki: string;
}

const lanDescriptorSchema = z.strictObject({
  v: z.literal(LAN_VERSION),
  ip: z.string(),
  port: z.number().int().min(1).max(65_535),
  spki: hex64,
});

export function encodeLanDescriptor(value: LanDescriptor, allowLoopback = false): string {
  if (
    !canonicalIpv4(value.ip, allowLoopback) ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    !/^[0-9a-f]{64}$/.test(value.spki)
  )
    throw new Error("lan_descriptor_invalid");
  return JSON.stringify({ v: LAN_VERSION, ip: value.ip, port: value.port, spki: value.spki });
}

export function decodeLanDescriptor(
  text: string,
  allowLoopback = false,
): LanDescriptor | undefined {
  if (text.length > 160) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = lanDescriptorSchema.safeParse(raw);
  if (!parsed.success || !canonicalIpv4(parsed.data.ip, allowLoopback)) return undefined;
  const descriptor = parsed.data;
  return encodeLanDescriptor(descriptor, allowLoopback) === text ? descriptor : undefined;
}

export const pairExchangeSchema = z
  .strictObject({
    v: z.literal(LAN_VERSION),
    session: hex32,
    seq: z.number().int().min(0).max(131_072),
    kind: z.enum(["send", "poll"]),
    body: b64.max(Math.ceil((LAN_MAX_PAIR_BYTES * 4) / 3) + 4).optional(),
  })
  .refine((value) => (value.kind === "send" ? value.body !== undefined : value.body === undefined));

export const pairExchangeReplySchema = z
  .strictObject({
    v: z.literal(LAN_VERSION),
    seq: z.number().int().min(0).max(131_072),
    kind: z.enum(["message", "pending", "closed"]),
    body: b64.max(Math.ceil((LAN_MAX_PAIR_BYTES * 4) / 3) + 4).optional(),
    code: z.enum(["unavailable", "expired", "cancelled", "invalid", "busy"]).optional(),
  })
  .refine((value) =>
    value.kind === "message" ? value.body !== undefined : value.body === undefined,
  );

export const lanChallengeRequestSchema = z
  .strictObject({
    v: z.literal(LAN_VERSION),
    vault: hex32,
    device: hex32,
    purpose: z.enum(["carrier", "resume"]),
    session: hex32.optional(),
  })
  .refine((value) =>
    value.purpose === "resume" ? value.session !== undefined : value.session === undefined,
  );

export const lanAuthSchema = z.strictObject({
  v: z.literal(LAN_VERSION),
  vault: hex32,
  device: hex32,
  nonce: hex64,
  signature: z.string().regex(/^[0-9a-f]{128}$/),
});

export const lanCarrierRequestSchema = z
  .strictObject({
    v: z.literal(LAN_VERSION),
    method: z.enum(["list", "read", "append"]),
    vault: hex32,
    device: hex32,
    writer: hex32.optional(),
    seg: z.number().int().min(1).max(2_147_483_647).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    bytes: b64.max(Math.ceil((LAN_MAX_APPEND_BYTES * 4) / 3) + 4).optional(),
    auth: lanAuthSchema,
  })
  .refine((value) => value.auth.vault === value.vault && value.auth.device === value.device)
  .refine((value) => {
    if (value.method === "list")
      return (
        value.writer === undefined &&
        value.seg === undefined &&
        value.offset === undefined &&
        value.bytes === undefined
      );
    if (value.method === "read")
      return (
        value.writer !== undefined &&
        value.seg !== undefined &&
        value.offset !== undefined &&
        value.bytes === undefined
      );
    return (
      value.writer !== undefined &&
      value.seg !== undefined &&
      value.offset !== undefined &&
      value.bytes !== undefined
    );
  });

export const lanPairResumeSchema = z.strictObject({
  v: z.literal(LAN_VERSION),
  session: hex32,
  vault: hex32,
  device: hex32,
  auth: lanAuthSchema,
});

export const lanPairResumeReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    v: z.literal(LAN_VERSION),
    kind: z.literal("ready"),
    firstSeq: z.number().int().min(0),
  }),
  z.strictObject({
    v: z.literal(LAN_VERSION),
    kind: z.literal("refused"),
    code: z.enum(["unavailable", "expired", "unauthorized", "unknown"]),
  }),
]);

export const lanCarrierReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    v: z.literal(LAN_VERSION),
    kind: z.literal("list"),
    segments: z
      .array(
        z.strictObject({
          writer: hex32,
          seg: z.number().int().min(1),
          size: z.number().int().nonnegative(),
        }),
      )
      .max(65_536),
  }),
  z.strictObject({
    v: z.literal(LAN_VERSION),
    kind: z.literal("read"),
    bytes: b64.max(Math.ceil((LAN_MAX_READ_BYTES * 4) / 3) + 4),
  }),
  z.strictObject({
    v: z.literal(LAN_VERSION),
    kind: z.literal("append"),
    size: z.number().int().nonnegative(),
    digest: hex64,
  }),
  z.strictObject({
    v: z.literal(LAN_VERSION),
    kind: z.literal("refused"),
    code: z.enum([
      "unavailable",
      "invalid",
      "unauthorized",
      "offset_conflict",
      "too_large",
      "busy",
      "unknown",
    ]),
  }),
]);

export type LanCarrierReply = z.infer<typeof lanCarrierReplySchema>;

export function lanBytesDigest(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deterministic bytes signed under cashu/lan-auth/v1. The path is fixed, never caller supplied. */
export function lanAuthBody(input: {
  readonly purpose: "carrier" | "resume";
  readonly path: typeof LAN_CARRIER_PATH | typeof LAN_PAIR_RESUME_PATH;
  readonly method: "list" | "read" | "append" | "resume";
  readonly vault: string;
  readonly device: string;
  readonly writer?: string;
  readonly seg?: number;
  readonly offset?: number;
  readonly bytesDigest?: string;
  readonly session?: string;
  readonly nonce: string;
  readonly expiresAt: number;
}): Uint8Array {
  const body = JSON.stringify({
    v: LAN_VERSION,
    purpose: input.purpose,
    path: input.path,
    method: input.method,
    vault: input.vault,
    device: input.device,
    writer: input.writer ?? null,
    seg: input.seg ?? null,
    offset: input.offset ?? null,
    bytesDigest: input.bytesDigest ?? null,
    session: input.session ?? null,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
  });
  return new TextEncoder().encode(body);
}

export type PairExchangeReply = z.infer<typeof pairExchangeReplySchema>;
export type LanCarrierRequest = z.infer<typeof lanCarrierRequestSchema>;
