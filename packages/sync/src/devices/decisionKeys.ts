// THE rule for keys that back revocation decisions (S29c review P2 and its variants V1 / V2; the
// invariant and why it closes the class: crypto/README.md "Decision keys").
//
// Under a revocation set (the one a fold step assumes, or the final one), the DECISION KEYS of a
// device are the key pairs certified for it through chains that start at the recovery key and pass
// only through devices outside that set:
// - a device that is not revoked: its keys in the certificate closure that avoids every revoked
//   device;
// - a revoked device: the key pairs a signer of that same closure certified for it (what verified
//   its statements before its cut; its own certificates never count).
// So every link of a decision key's chain is a certificate by the recovery key or by a device that is
// not revoked: a certificate made by a revoked device (before or after its cut, genuine or a rewrite
// of an old frame) or by anything it certified never contributes.
//
// Every place that accepts a statement as evidence for a revocation decision goes through `keysOf`:
// revocation eligibility and M1 attestations (revocations.ts, under each fixpoint step's assumed
// revocations), and, through `statementKeys` and `Registry.statementKeys`, lease events, watermarks,
// recovery changes and names (under the final revocations).

import type { SegmentCursor } from "../carrier.js";
import type { CandidateKey, CertificateIndex } from "../crypto/index.js";
import { beforeCut } from "./positions.js";

export class DecisionKeys {
  readonly #index: CertificateIndex;
  readonly #revoked: ReadonlySet<string>;
  readonly #closure: ReturnType<CertificateIndex["closure"]>;
  #trusted: ReturnType<CertificateIndex["verify"]>["devices"] | undefined;

  constructor(index: CertificateIndex, revoked: ReadonlySet<string>) {
    this.#index = index;
    this.#revoked = revoked;
    this.#closure = index.closure(revoked);
  }

  /** The decision keys of `device` under this revocation set (empty: none). */
  keysOf(device: string): readonly CandidateKey[] {
    return this.#revoked.has(device)
      ? this.#closure.certifiedKeysOf(device)
      : this.#closure.keysOf(device);
  }

  /** The decision keys' signing keys, as statement verifiers take them. */
  signKeysOf(device: string): Uint8Array[] {
    return this.keysOf(device).map((k) => k.signPublicKey.slice());
  }

  /**
   * The keys a statement `device` wrote at `position` (cursor after its batch) may verify with:
   * for a revoked device its decision keys when the statement lies before its cut; for any other
   * device its one decision key when the trust resolves it (a conflicted device writes nothing that
   * counts; `CertificateIndex.verify` picks among the decision keys, never outside them).
   */
  statementKeys(
    device: string,
    position: SegmentCursor,
    revoked: ReadonlyMap<string, { readonly cut: SegmentCursor }>,
  ): Uint8Array[] {
    const revocation = revoked.get(device);
    if (revocation) return beforeCut(position, revocation.cut) ? this.signKeysOf(device) : [];
    this.#trusted ??= this.#index.verify(this.#revoked).devices;
    const key = this.#trusted.get(device)?.signPublicKey;
    return key ? [key.slice()] : [];
  }
}
