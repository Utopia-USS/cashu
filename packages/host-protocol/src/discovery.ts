// `<data dir>/run/host.json`: written by the host after its socket listens (temp file + rename,
// 0600), read by clients to find the socket (it may live in the short-path fallback directory) and to
// show status. Never trusted for authentication: the handshake is.
import { z } from "zod";
import { dataDirIdSchema } from "./messages.js";
import { protocolVersionSchema } from "./version.js";

export const DISCOVERY_FORMAT = 1;

export const discoverySchema = z.object({
  format: z.literal(DISCOVERY_FORMAT),
  pid: z.number().int().positive(),
  socket: z.string().min(1).max(1_024),
  protocol: protocolVersionSchema,
  build: z.string().min(1).max(200),
  startedAt: z.iso.datetime(),
  dataDir: dataDirIdSchema,
});
export type HostDiscovery = z.infer<typeof discoverySchema>;
