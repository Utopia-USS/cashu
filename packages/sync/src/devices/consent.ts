// Revocation consent (H2) verification, shared by the registry fold (trust.ts) and the revoke flow
// (Registry.consentAccepted). A consent counts only with a decision key of its target under the
// exclusion of the revocation's signer, everything it certified (at any depth), and the devices
// revoked with the recovery words (review H5'): the signer can never vouch for its own victims, and
// it stays independent of the device revocations being decided.

import { accepted } from "./acceptance.js";
import { fromHex } from "./bytes.js";
import type { DecisionKeys } from "./decisionKeys.js";
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
