// Revocation consent (H2) verification, shared by the registry fold (trust.ts) and the revoke flow
// (Registry.consentAccepted). A consent counts only with a decision key of its target under the
// exclusion of the revocation's signer and everything it certified (at any depth, H5'), and of every
// RETIRED device (H5''): revoked with the recovery words, or retired by a revocation its targets
// genuinely consented to (an old phone retired and later sold must not mint consent keys). It stays
// independent of the device revocations being decided (no fixpoint step's assumptions).

import { accepted } from "./acceptance.js";
import { fromHex } from "./bytes.js";
import { DecisionKeys } from "./decisionKeys.js";
import { revocationConsentBody } from "./events.js";
import type { StatementVerifier } from "./statements.js";

/** The targets (other than the signer) whose consent is missing or does not verify. */
export function unconsentedTargets(
  verify: StatementVerifier,
  keys: DecisionKeys,
  vaultId: string,
  eid: string,
  entries: readonly { readonly device: string; readonly cut: { seg: number; offset: number } }[],
  signer: string,
  consent: Readonly<Record<string, string>> | undefined,
): string[] {
  const body = revocationConsentBody(vaultId, eid, entries, signer);
  return entries
    .map((e) => e.device)
    .filter((device) => {
      if (device === signer) return false;
      const sig = consent?.[device];
      return (
        sig === undefined ||
        !accepted(verify, "cashu/registry/v1", body, fromHex(sig), {
          kind: "consent",
          keys,
          device,
          avoid: signer,
        })
      );
    });
}

/** A device-signed revocation that may retire its targets: `ok` checks its consents under `keys`. */
export interface RetirementCandidate {
  readonly targets: readonly string[];
  readonly ok: (keys: DecisionKeys) => boolean;
}

/**
 * The retired devices (H5''): the devices the words revoked, plus, to a fixpoint, the targets of
 * every revocation whose consents verify while avoiding the retired set. Each round tests every
 * pending revocation twice: under the retired set plus EVERY target still pending (strong: no
 * consent key may rest on a device that is itself being retired, as a sold phone minting keys for
 * the others would), and under the retired set alone (minimal). It adds the targets of the strong
 * passes; when there are none it drops the candidates that fail even minimally (junk: it can never
 * add an honest device, which needs that device's genuine consent); when nothing moves it retires
 * all pending targets (fail closed for consents: the words still work). The set only grows, so this
 * terminates and depends only on the event set.
 */
export function retiredDevices(
  index: ConstructorParameters<typeof DecisionKeys>[0],
  certain: ReadonlySet<string>,
  candidates: readonly RetirementCandidate[],
): Set<string> {
  const retired = new Set(certain);
  let pending = [...candidates];
  for (;;) {
    pending = pending.filter((c) => c.targets.some((t) => !retired.has(t)));
    if (pending.length === 0) return retired;
    const round = new Set(retired);
    for (const c of pending) for (const t of c.targets) round.add(t);
    const strong = new DecisionKeys(index, round);
    const passed = pending.filter((c) => c.ok(strong));
    if (passed.length > 0) {
      for (const c of passed) for (const t of c.targets) retired.add(t);
      continue;
    }
    const minimal = new DecisionKeys(index, retired);
    const kept = pending.filter((c) => c.ok(minimal));
    if (kept.length < pending.length) {
      pending = kept;
      continue;
    }
    for (const t of round) retired.add(t);
    return retired;
  }
}
