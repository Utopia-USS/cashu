// Bounded head dissemination bookkeeping. The own log's accepted gossip events are receipts;
// prepared events and a view snapshot alone never acknowledge publication.

import type { SegmentCursor } from "../carrier.js";
import { decodeHead, encodeHead, type SignedHead } from "../crypto/index.js";
import { toHex } from "./bytes.js";
import { comparePositions } from "./positions.js";

export const MAX_GOSSIP_HISTORY = 256;

export class GossipLedger {
  readonly #frontiers = new Map<string, SignedHead>();
  readonly #proofs = new Set<string>();
  readonly #ordinary = new Map<string, SignedHead>();
  #overflow = false;

  get overflow(): boolean {
    return this.#overflow;
  }

  markOverflow(): void {
    this.#overflow = true;
  }

  /** Only a frame which contains an ordinary event may become a local source. */
  ordinary(head: SignedHead): void {
    const old = this.#ordinary.get(head.device);
    if (!old || comparePositions(head, old) > 0) this.#ordinary.set(head.device, head);
  }

  /** Decode only a committed event found in this installation's authenticated own stream. */
  receipt(encoded: readonly string[]): void {
    const atEnd = new Map<string, string[]>();
    for (const value of encoded) {
      const head = decodeHead(value);
      if (!head) continue;
      const key = `${head.device}|${head.seg}:${head.offset}`;
      const group = atEnd.get(key) ?? [];
      group.push(value);
      atEnd.set(key, group);
      const old = this.#frontiers.get(head.device);
      if (!old || comparePositions(head, old) > 0) {
        this.#frontiers.set(head.device, head);
      }
    }
    for (const group of atEnd.values()) {
      if (group.length < 2) continue;
      const chains = new Set(group.map((value) => toHex((decodeHead(value) as SignedHead).chain)));
      if (chains.size < 2) continue;
      for (const value of group) {
        if (this.#proofs.size >= MAX_GOSSIP_HISTORY && !this.#proofs.has(value))
          this.#overflow = true;
        else this.#proofs.add(value);
      }
    }
  }

  /** Candidates are supplied after their signature and trust have been checked by the gate. */
  candidates(
    localDevice: string,
    attested: readonly SignedHead[],
    proofs: readonly (readonly [SignedHead, SignedHead])[],
  ): SignedHead[] {
    if (this.#overflow) return [];
    const latest = new Map<string, SignedHead>();
    for (const head of [...this.#ordinary.values(), ...attested]) {
      if (head.device === localDevice) continue;
      const old = this.#frontiers.get(head.device);
      if (old && comparePositions(head, old) <= 0) continue;
      const chosen = latest.get(head.device);
      if (!chosen || comparePositions(head, chosen) > 0) latest.set(head.device, head);
    }
    const out = new Map<string, SignedHead>();
    for (const head of latest.values()) out.set(encodeHead(head), head);
    for (const pair of proofs) {
      if (pair[0].device === localDevice) continue;
      if (pair.every((head) => this.#proofs.has(encodeHead(head)))) continue;
      for (const head of pair) out.set(encodeHead(head), head);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, head]) => head);
  }

  export(): {
    readonly frontiers: readonly string[];
    readonly proofs: readonly string[];
    readonly ordinary: readonly string[];
    readonly overflow: boolean;
  } {
    return {
      frontiers: [...this.#frontiers.values()].map(encodeHead).sort(),
      proofs: [...this.#proofs].sort(),
      ordinary: [...this.#ordinary.values()].map(encodeHead).sort(),
      overflow: this.#overflow,
    };
  }

  restore(snapshot: ReturnType<GossipLedger["export"]>): void {
    this.#frontiers.clear();
    this.#proofs.clear();
    this.#ordinary.clear();
    for (const value of snapshot.frontiers) {
      const head = decodeHead(value);
      if (head) this.#frontiers.set(head.device, head);
    }
    for (const value of snapshot.proofs) this.#proofs.add(value);
    for (const value of snapshot.ordinary) {
      const head = decodeHead(value);
      if (head) this.#ordinary.set(head.device, head);
    }
    this.#overflow = snapshot.overflow;
  }

  frontier(device: string): SegmentCursor | undefined {
    const head = this.#frontiers.get(device);
    return head ? { seg: head.seg, offset: head.offset } : undefined;
  }
}
