// Protocol versioning. Peers must share the major version: a different major is refused at the hello
// with a fixed message, before anything else is parsed. The minor version and the host's `features`
// list are additive (new methods, new optional fields); a client uses only what the host announces.
import { z } from "zod";

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * The version this build speaks. Bump `major` only for a change old peers cannot ignore.
 * 1.1: optional `admin.status` fields (safeMode, vaults, pendingWrites) and `admin.handover`.
 * 1.2: the shim's `cli.*` methods (feature `cli.exec`) and `mcp` session notes (feature `mcp.lines`).
 * 1.3: exact UI-role native Create RPCs (feature `native.creation.v1`).
 * 1.4: exact UI-role one-use notification intent resolution (feature `native.notification.intent.v1`).
 * 1.5: verified packaged content-build match for ui/cli/mcp handshakes; admin stays cross-build.
 * 1.6: exact UI-role native device revocation RPCs (feature `native.devices.v1`).
 * 1.7: exact UI-role native pairing RPCs (feature `native.pairing.v1`).
 * 1.7 also admits the additive `native.connectors.v1` picker capability: prepareInstall returns a
 * session-bound one-use token, commitInstall consumes it with a main-process selected directory.
 * No arbitrary path is exposed in the renderer. Unknown connector methods close the UI session.
 * 1.8: the `starting` refusal: a host still opening its stores refuses hellos with it, and clients
 * wait for that host (bounded) instead of starting another one. An older client reads it as an
 * invalid reply and retries, which is also safe.
 */
export const HOST_PROTOCOL: ProtocolVersion = { major: 1, minor: 8 };

export const protocolVersionSchema = z.object({
  major: z.number().int().min(0).max(65_535),
  minor: z.number().int().min(0).max(65_535),
});

/** True when two peers can talk: the same major version. */
export function compatible(a: ProtocolVersion, b: ProtocolVersion): boolean {
  return a.major === b.major;
}
