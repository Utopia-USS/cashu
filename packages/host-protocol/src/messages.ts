// Messages on the host socket, validated with zod on both ends. Two phases:
// 1. handshake (unauthenticated): hello -> challenge | refused, auth -> ready | refused;
// 2. session (after `ready`): requests with per-connection ids, cancels, notifications, and the
//    channel frames (`store` for the UI's store channel v2, `mcp` for MCP JSON-RPC lines).
// Which session frames a connection may send is fixed by the role it named at hello (roles.ts).
import { z } from "zod";
import { protocolVersionSchema } from "./version.js";

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));

/** 32 random bytes, hex: one per side per handshake. */
export const nonceSchema = hex(32);
/** HMAC-SHA256 proof, hex. */
const proofSchema = hex(32);
/** The host token on disk: 32 random bytes, hex, new at every host start. */
export const tokenSchema = hex(32);
/** SHA-256 of the data dir's real path, hex: names the host a client means. */
export const dataDirIdSchema = hex(32);

export const ROLES = ["ui", "mcp", "cli", "admin"] as const;
export const roleSchema = z.enum(ROLES);
/**
 * - `ui`: the store channel and exact `native.creation.*` and `native.devices.*` methods;
 * - `mcp`: MCP lines for exactly one profile, fixed at hello, and `mcp.*` requests (`mcp.open`);
 * - `cli`: `cli.*` requests only;
 * - `admin`: `admin.*` requests (status, stop).
 * Least privilege for our own clients, not a boundary against same-user code.
 */
export type Role = z.infer<typeof roleSchema>;

/** A profile slug as the Python app makes them (lower-case ASCII words joined by "-"). */
export const profileSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

const buildSchema = z.string().min(1).max(200);
const featuresSchema = z.array(z.string().min(1).max(64)).max(64);

// ---------------------------------------------------------------------------------------------
// Handshake

/** The part of a hello every major version shares: enough to refuse another major. */
export const helloHeadSchema = z.object({ t: z.literal("hello"), protocol: protocolVersionSchema });

export const helloSchema = z
  .object({
    t: z.literal("hello"),
    protocol: protocolVersionSchema,
    role: roleSchema,
    dataDir: dataDirIdSchema,
    /** Required for `mcp` (the one profile the session serves), absent for every other role. */
    profile: profileSlugSchema.optional(),
    build: buildSchema,
    nc: nonceSchema,
  })
  .refine((h) => (h.role === "mcp") === (h.profile !== undefined), {
    message: "an mcp session names exactly one profile; other roles name none",
    path: ["profile"],
  });
export type Hello = z.infer<typeof helloSchema>;

const challengeSchema = z.object({
  t: z.literal("challenge"),
  ns: nonceSchema,
  /** The host proves it holds the token first, so a squatting server learns nothing. */
  proof: proofSchema,
  protocol: protocolVersionSchema,
  build: buildSchema,
  features: featuresSchema,
});
export type Challenge = z.infer<typeof challengeSchema>;

export const authSchema = z.object({ t: z.literal("auth"), proof: proofSchema });
export type Auth = z.infer<typeof authSchema>;

const readySchema = z.object({ t: z.literal("ready") });

export const REFUSAL_REASONS = [
  "protocol",
  "data-dir",
  "build",
  "role",
  "auth",
  "stopping",
  "invalid",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/**
 * Fixed developer-facing texts per reason (clients show their own localized text by reason). They
 * never carry values from the request.
 */
export const REFUSAL_MESSAGES: Readonly<Record<RefusalReason, string>> = {
  protocol: "incompatible host protocol: restart the background service after updating cashU",
  "data-dir": "this host serves another data dir",
  build: "this app and host are different installed builds",
  role: "the hello does not fit its role",
  auth: "authentication failed",
  stopping: "the host is stopping",
  invalid: "invalid handshake message",
};

const refusedSchema = z.object({
  t: z.literal("refused"),
  reason: z.enum(REFUSAL_REASONS),
  message: z.string().max(500),
});
export type Refused = z.infer<typeof refusedSchema>;

/** What a client can receive before `ready`. */
export const hostHandshakeSchema = z.discriminatedUnion("t", [
  challengeSchema,
  readySchema,
  refusedSchema,
]);

// ---------------------------------------------------------------------------------------------
// Session

const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Namespaced method names: `admin.status`, `cli.exec`, `jobs.run`. */
export const methodSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/)
  .max(64);
const json = z.json();
/** An MCP JSON-RPC message as one line (no newline inside). */
const mcpLine = z
  .string()
  .max(16 * 1024 * 1024)
  .refine((s) => !s.includes("\n"), "an MCP line has no newline");

export const clientFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("req"), id: requestId, method: methodSchema, params: json }),
  z.object({ t: z.literal("cancel"), id: requestId }),
  /** A store channel message (`@cashu/host-protocol/store` `storeToHostSchema`). */
  z.object({ t: z.literal("store"), m: json }),
  z.object({ t: z.literal("mcp"), line: mcpLine }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const callErrorSchema = z.object({
  /** A stable code (`unknown-method`, `invalid-params`, `failed`, `cancelled`, a method's own). */
  code: z.string().min(1).max(64),
  message: z.string().max(2_000),
});
export type CallError = z.infer<typeof callErrorSchema>;

export const hostFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("res"),
    id: requestId,
    outcome: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), result: json }),
      z.object({ ok: z.literal(false), error: callErrorSchema }),
    ]),
  }),
  /** Progress or a stream item of request `id`, or an unsolicited event when `id` is absent. */
  z.object({ t: z.literal("note"), id: requestId.optional(), method: methodSchema, params: json }),
  z.object({ t: z.literal("store"), m: json }),
  z.object({ t: z.literal("mcp"), line: mcpLine }),
]);
export type HostFrame = z.infer<typeof hostFrameSchema>;
