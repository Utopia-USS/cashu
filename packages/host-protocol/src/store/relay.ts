// The desktop relay around the store channel. Electron main carries the store channel between the
// renderer's MessagePort and its own `ui` session on the host without reading it: renderer messages go
// into `store` frames as they are, the host's `store` frames come out as their `m`. Toward the
// renderer main adds one message of its own, `link`, saying what its connection to the host does:
//   connecting   (re)connecting to the data dir's host
//   starting     no host answered: main started one and waits for it
//   connected    a session is up; the host's store `ready` follows
//   unavailable  the host could not be reached or started; main keeps retrying
// Store messages the renderer sends while the link is down are dropped by main; the client re-sends
// its live subscriptions and unanswered runs (same idempotency keys) after the next `ready`.
import { z } from "zod";
import { storeToClientSchema } from "./messages.js";

export const LINK_STATES = ["connecting", "starting", "connected", "unavailable"] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const linkMessageSchema = z.object({ t: z.literal("link"), state: z.enum(LINK_STATES) });
export type LinkMessage = z.infer<typeof linkMessageSchema>;

/** What the renderer's store client receives through the relay: a host store message or a link state. */
export const relayToClientSchema = z.discriminatedUnion("t", [
  linkMessageSchema,
  ...storeToClientSchema.options,
]);
export type RelayToClient = z.infer<typeof relayToClientSchema>;
