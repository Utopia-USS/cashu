// What this device knows about every writer's stream from signed heads (S29c phase B2): the key
// each stream is bound to, the chain after every verified frame it holds, and the heads of a writer
// that OTHER statements carry (attestations: revocation cuts). Pure bookkeeping; the gate
// (gate.ts) verifies every signature through acceptance.ts before anything is recorded here.
//
// - Stream key: an honest device has ONE signing key for its life (a fresh identity per install),
//   so the key that verified the first frame of a stream is the only key any later frame of that
//   stream may verify with. A key certified for the device later (a second key pair minted by a
//   still-trusted thief) can therefore never sign into an existing stream: a frame rewritten with
//   it is rejected like any forgery, whatever any fold step assumes about revocations.
// - Fork: only the writer's own key can sign a head, so two heads of one writer at the same end
//   with different chains, or an attested head whose chain differs from the chain this device holds
//   at that end, prove that the writer signed two histories (a rewritten stream, or an identity
//   restored onto a second install). Such a writer is FROZEN at the agreed prefix (lead decision
//   D5): the highest attested end whose chain matches what this device holds, with no conflict at or
//   before it, else the start. Its data and statements after that are not accepted; the owner is
//   told (`forks`) and revokes it. No automatic revocation.
// - Behind: an attestation that names a later end than this device holds proves the writer wrote
//   more (truncation or withholding by storage, or simply not synced yet); reported, never frozen.
//   Detecting withholding beyond what cuts attest (head gossip) is deferred (lead decision D10).
//
// Everything here is a function of the frames and statements held, so it is the same on every
// device holding the same set, whatever the delivery order; it survives view rebuilds.

import type { SegmentCursor } from "../carrier.js";
import type { SignedHead } from "../crypto/index.js";
import { toHex as toHexBytes } from "./bytes.js";
import { comparePositions, positionKey } from "./positions.js";

export interface ForkReport {
  readonly device: string;
  /** Data and statements of the device ending after this are not accepted. */
  readonly agreed: SegmentCursor;
}

export interface BehindReport {
  readonly device: string;
  /** The highest end another device attests the writer signed. */
  readonly attested: SegmentCursor;
  /** The end of what this device holds of that stream (start when nothing). */
  readonly held: SegmentCursor;
}

const START: SegmentCursor = { seg: 1, offset: 0 };

function cursorOf(head: SignedHead): SegmentCursor {
  return { seg: head.seg, offset: head.offset };
}

export class StreamIndex {
  /** `device|stream` -> the key that verified the stream's first frame. */
  readonly #keys = new Map<string, Uint8Array>();
  /** device -> end -> every verified chain at that end (data stream), first one first. */
  readonly #chains = new Map<string, Map<string, { head: SignedHead; chains: string[] }>>();
  /** device -> the end of the last verified frame held (data stream). */
  readonly #held = new Map<string, SegmentCursor>();
  /** device -> attested heads by their hex, unverified (judged against the stream key on use). */
  readonly #attested = new Map<string, Map<string, SignedHead>>();

  boundKey(device: string, stream: 0 | 1): Uint8Array | undefined {
    return this.#keys.get(`${device}|${stream}`);
  }

  bind(device: string, stream: 0 | 1, key: Uint8Array): void {
    const k = `${device}|${stream}`;
    if (!this.#keys.has(k)) this.#keys.set(k, key.slice());
  }

  /** A verified data-stream head of a frame this device holds. */
  observe(head: SignedHead): void {
    const byEnd = this.#chains.get(head.device) ?? new Map();
    const key = positionKey(cursorOf(head));
    const chain = toHexBytes(head.chain);
    const known = byEnd.get(key);
    if (!known) byEnd.set(key, { head, chains: [chain] });
    else if (!known.chains.includes(chain)) known.chains.push(chain);
    this.#chains.set(head.device, byEnd);
    const held = this.#held.get(head.device);
    if (!held || comparePositions(cursorOf(head), held) > 0) {
      this.#held.set(head.device, cursorOf(head));
    }
  }

  /** Stream keys as `[device, stream, key]` (the gate snapshot, gateState.ts). */
  exportKeys(): [string, 0 | 1, Uint8Array][] {
    return [...this.#keys.entries()].map(([k, key]) => {
      const [device, stream] = k.split("|");
      return [device ?? "", stream === "0" ? 0 : 1, key.slice()];
    });
  }

  /** Every verified data-stream head held, with the other chains seen at its end (snapshot). */
  exportHeads(): { readonly head: SignedHead; readonly others: readonly string[] }[] {
    const out: { head: SignedHead; others: string[] }[] = [];
    for (const byEnd of this.#chains.values()) {
      for (const known of byEnd.values())
        out.push({ head: known.head, others: known.chains.slice(1) });
    }
    return out;
  }

  /** Restores what `exportKeys` / `exportHeads` returned (into an empty index; attestations are re-derived). */
  restore(
    keys: readonly (readonly [string, 0 | 1, Uint8Array])[],
    heads: readonly { readonly head: SignedHead; readonly others: readonly string[] }[],
  ): void {
    for (const [device, stream, key] of keys) this.bind(device, stream, key);
    for (const { head, others } of heads) {
      this.observe(head);
      const known = this.#chains.get(head.device)?.get(positionKey(cursorOf(head)));
      for (const chain of others)
        if (known && !known.chains.includes(chain)) known.chains.push(chain);
    }
  }

  /** The end of the last verified frame of `device` this device holds (undefined: none). */
  held(device: string): SegmentCursor | undefined {
    return this.#held.get(device);
  }

  /** The verified head of `device` ending at `end` that this device holds (the first one seen). */
  headAt(device: string, end: SegmentCursor): SignedHead | undefined {
    return this.#chains.get(device)?.get(positionKey(end))?.head;
  }

  /** A head of `device` carried by a statement (not verified yet). */
  attest(head: SignedHead): void {
    const byHex = this.#attested.get(head.device) ?? new Map<string, SignedHead>();
    byHex.set(
      `${positionKey(cursorOf(head))}|${toHexBytes(head.chain)}|${toHexBytes(head.sig)}`,
      head,
    );
    this.#attested.set(head.device, byHex);
  }

  /** Devices with attestations, sorted. */
  attestedDevices(): string[] {
    return [...this.#attested.keys()].sort();
  }

  attestations(device: string): readonly SignedHead[] {
    return [...(this.#attested.get(device)?.values() ?? [])];
  }

  /**
   * Proven forks and the agreed prefix of each (`genuine` says whether an attested head was signed
   * by the writer's stream key; heads that fail it are ignored: anyone can write junk).
   */
  forks(genuine: (head: SignedHead) => boolean): ForkReport[] {
    const out: ForkReport[] = [];
    const devices = new Set([...this.#chains.keys(), ...this.#attested.keys()]);
    for (const device of [...devices].sort()) {
      const conflicts: SegmentCursor[] = [];
      const matches: SegmentCursor[] = [];
      for (const known of this.#chains.get(device)?.values() ?? []) {
        if (known.chains.length > 1) conflicts.push(cursorOf(known.head));
      }
      for (const head of this.attestations(device)) {
        if (!genuine(head)) continue;
        const held = this.#chains.get(device)?.get(positionKey(cursorOf(head)));
        if (!held) continue; // not held (yet): undecided, see `behind`
        if (held.chains.length === 1 && held.chains[0] === toHexBytes(head.chain)) {
          matches.push(cursorOf(head));
        } else {
          conflicts.push(cursorOf(head));
        }
      }
      if (conflicts.length === 0) continue;
      const firstConflict = conflicts.reduce((a, b) => (comparePositions(a, b) <= 0 ? a : b));
      const agreed = matches
        .filter((m) => comparePositions(m, firstConflict) < 0)
        .reduce((a, b) => (comparePositions(a, b) >= 0 ? a : b), START);
      out.push({ device, agreed });
    }
    return out;
  }

  /** Writers that genuine attestations show further ahead than what this device holds. */
  behind(genuine: (head: SignedHead) => boolean): BehindReport[] {
    const out: BehindReport[] = [];
    for (const device of this.attestedDevices()) {
      const held = this.#held.get(device) ?? START;
      let attested: SegmentCursor | undefined;
      for (const head of this.attestations(device)) {
        if (!genuine(head)) continue;
        const at = cursorOf(head);
        if (comparePositions(at, held) > 0 && (!attested || comparePositions(at, attested) > 0)) {
          attested = at;
        }
      }
      if (attested) out.push({ device, attested, held });
    }
    return out;
  }
}
