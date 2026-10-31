// Runs the pairing protocol (pairing.ts) over a pluggable, untrusted message link: a relay channel,
// a local socket, or an in-memory pair in tests. The link only moves sealed bytes; every security
// property comes from the protocol, so the link may drop, reorder, replay or forge messages.

import type {
  InviterWelcome,
  JoinerWelcome,
  PairingFailed,
  PairingInviter,
  PairingJoiner,
  PairingStep,
} from "./pairing.js";

export interface PairingLink {
  send(message: Uint8Array): Promise<void>;
  /** The next message from the peer; rejects when the link closes or times out. */
  receive(): Promise<Uint8Array>;
}

export interface InviterDriver {
  /** Inviter clock, ms. */
  readonly now: () => number;
  /** Show the SAS and resolve true only when the owner confirmed both screens match. */
  readonly confirmSas: (sas: string) => Promise<boolean>;
  /** Eid for the `device.added` event. */
  readonly eid: () => string;
}

export interface JoinerDriver {
  readonly now: () => number;
  /** Show the SAS on this screen (the owner compares it with the inviter's). */
  readonly showSas: (sas: string) => void;
}

async function failed(link: PairingLink, step: PairingFailed): Promise<PairingFailed> {
  if (step.reply) {
    try {
      await link.send(step.reply);
    } catch {
      // The session is over either way; a lost abort only delays the peer's timeout.
    }
  }
  return { ok: false, reason: step.reason };
}

export async function runInviter(
  inviter: PairingInviter,
  link: PairingLink,
  driver: InviterDriver,
): Promise<PairingStep<InviterWelcome>> {
  const challenge = inviter.receiveHello(await link.receive(), driver.now());
  if (!challenge.ok) return failed(link, challenge);
  await link.send(challenge.value.reply);
  const shown = inviter.receiveReveal(await link.receive());
  if (!shown.ok) return failed(link, shown);
  if (!(await driver.confirmSas(shown.value.sas))) return failed(link, inviter.reject());
  const welcome = inviter.confirm(driver.eid());
  if (!welcome.ok) return failed(link, welcome);
  await link.send(welcome.value.reply);
  return welcome;
}

export async function runJoiner(
  joiner: PairingJoiner,
  hello: Uint8Array,
  link: PairingLink,
  driver: JoinerDriver,
): Promise<PairingStep<JoinerWelcome>> {
  await link.send(hello);
  const reveal = joiner.receiveChallenge(await link.receive(), driver.now());
  if (!reveal.ok) return failed(link, reveal);
  driver.showSas(reveal.value.sas);
  await link.send(reveal.value.reply);
  const welcome = joiner.receiveWelcome(await link.receive());
  if (!welcome.ok) return failed(link, welcome);
  return welcome;
}
