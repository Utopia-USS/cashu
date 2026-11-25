// Runs the pairing protocol (pairing.ts) over a pluggable, untrusted message link: a relay channel,
// a local socket, or an in-memory pair in tests. The link only moves sealed bytes; every security
// property comes from the protocol, so the link may drop, reorder, replay or forge messages.

import {
  type InviterWelcome,
  type JoinerWelcome,
  type PairingFailed,
  type PairingInviter,
  type PairingJoiner,
  type PairingStep,
  type PendingPairingSnapshot,
  SAS_ATTEMPTS,
} from "./pairing.js";

export interface PairingLink {
  send(message: Uint8Array): Promise<void>;
  /** The next message from the peer; rejects when the link closes or times out. */
  receive(): Promise<Uint8Array>;
}

export interface InviterDriver {
  /** Inviter clock, ms. */
  readonly now: () => number;
  /**
   * Ask the owner to type the 6 digits the new device shows (no "they match" button); undefined
   * when the owner cancels. `attemptsLeft` counts down after a wrong code.
   */
  readonly enterCode: (attemptsLeft: number) => Promise<string | undefined>;
  /** Eid for the `device.added` event. */
  readonly eid: () => string;
  /** Persist the decrypted hello subject before sending the signed challenge. */
  readonly afterHello?: (joiner: {
    readonly deviceId: string;
    readonly signPublicKey: Uint8Array;
    readonly boxPublicKey: Uint8Array;
  }) => Promise<void>;
  /** Persist the exact signed device.added and sealed receipt before any welcome byte leaves. */
  readonly beforeWelcome?: (welcome: InviterWelcome) => Promise<void>;
}

export interface JoinerDriver {
  readonly now: () => number;
  /** Show the SAS on this screen (the owner compares it with the inviter's). */
  readonly showSas: (sas: string) => void;
  /** Durable admission journals seal and reread this before the first reveal can leave. */
  readonly beforeReveal?: (snapshot: PendingPairingSnapshot) => Promise<void>;
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
  try {
    await driver.afterHello?.(challenge.value.joiner);
  } catch {
    return failed(link, inviter.reject());
  }
  await link.send(challenge.value.reply);
  const shown = inviter.receiveReveal(await link.receive(), driver.now());
  if (!shown.ok) return failed(link, shown);
  for (let attemptsLeft = SAS_ATTEMPTS; ; ) {
    const code = await driver.enterCode(attemptsLeft);
    if (code === undefined) return failed(link, inviter.reject());
    const welcome = inviter.confirm(code, driver.eid(), driver.now());
    if (welcome.ok) {
      try {
        await driver.beforeWelcome?.(welcome.value);
      } catch {
        return { ok: false, reason: "unexpected" };
      }
      await link.send(welcome.value.reply);
      for (const page of welcome.value.pages) await link.send(page);
      return welcome;
    }
    if (!("attemptsLeft" in welcome)) return failed(link, welcome);
    attemptsLeft = welcome.attemptsLeft;
  }
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
  if (driver.beforeReveal) {
    const snapshot = joiner.snapshotPending();
    if (!snapshot) return failed(link, { ok: false, reason: "unexpected" });
    try {
      await driver.beforeReveal(snapshot);
    } catch {
      return failed(link, joiner.rejectPending());
    }
  }
  driver.showSas(reveal.value.sas);
  await link.send(reveal.value.reply);
  let progress = joiner.receiveWelcome(await link.receive());
  while (progress.ok && !progress.value.done) progress = joiner.receivePage(await link.receive());
  if (!progress.ok) return failed(link, progress);
  return progress.value.done
    ? { ok: true, value: progress.value.welcome }
    : { ok: false, reason: "unexpected" };
}
