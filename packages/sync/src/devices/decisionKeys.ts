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
import { type CandidateKey, type CertificateIndex, RECOVERY_SIGNER_ID } from "../crypto/index.js";
import { beforeCut } from "./positions.js";

export class DecisionKeys {
  readonly #index: CertificateIndex;
  readonly #revoked: ReadonlySet<string>;
  readonly #closure: ReturnType<CertificateIndex["closure"]>;
  #trusted: ReturnType<CertificateIndex["verify"]>["devices"] | undefined;
  readonly #avoiding = new Map<string, Map<string, boolean>>();

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

  /**
   * The decision keys of `device` whose certification does not rest on `avoid`: a key counts only
   * when some chain from the recovery key to it passes neither through `avoid` nor through anything
   * `avoid` certified (H5': what a revocation's signer vouches for never consents to it).
   */
  keysAvoiding(device: string, avoid: string): readonly CandidateKey[] {
    if (device === avoid) return [];
    const memo = this.#avoiding.get(avoid) ?? new Map<string, boolean>();
    this.#avoiding.set(avoid, memo);
    return this.keysOf(device).filter((k) =>
      k.issuers.some((i) => this.#rootedAvoiding(i, avoid, memo)),
    );
  }

  #rootedAvoiding(id: string, avoid: string, memo: Map<string, boolean>): boolean {
    if (id === RECOVERY_SIGNER_ID) return true;
    if (id === avoid) return false;
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false); // a cycle never roots anything
    const ok = this.keysOf(id).some((k) =>
      k.issuers.some((i) => this.#rootedAvoiding(i, avoid, memo)),
    );
    memo.set(id, ok);
    return ok;
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
    const key = this.trustedKeyOf(device);
    return key ? [key] : [];
  }

  /**
   * The one decision key the trust resolves for a device outside the revocation set (undefined:
   * revoked, conflicted or unregistered): what verifies its current statements and key wraps.
   */
  trustedKeyOf(device: string): Uint8Array | undefined {
    this.#trusted ??= this.#index.verify(this.#revoked).devices;
    return this.#trusted.get(device)?.signPublicKey.slice();
  }
}
