// Protocol versioning. Peers must share the major version: a different major is refused at the hello
// with a fixed message, before anything else is parsed. The minor version and the host's `features`
// list are additive (new methods, new optional fields); a client uses only what the host announces.
import { z } from "zod";

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** The version this build speaks. Bump `major` only for a change old peers cannot ignore. */
export const HOST_PROTOCOL: ProtocolVersion = { major: 1, minor: 0 };

export const protocolVersionSchema = z.object({
  major: z.number().int().min(0).max(65_535),
  minor: z.number().int().min(0).max(65_535),
});

/** True when two peers can talk: the same major version. */
export function compatible(a: ProtocolVersion, b: ProtocolVersion): boolean {
  return a.major === b.major;
}
