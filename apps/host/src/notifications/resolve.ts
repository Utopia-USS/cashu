/** Click resolution checks the current host vault, never renderer selection or token possession alone. */
import { views } from "@cashu/domain/investments";
import { decisions, signalByGid } from "@cashu/store/investments/queries";
import type { HostStores, OpenVault } from "../stores.js";
import type { NotificationIntentLedger } from "./intentLedger.js";

export type NotificationTarget =
  | { readonly vaultId: string; readonly kind: "signal"; readonly signalId: string }
  | { readonly vaultId: string; readonly kind: "signalsSummary" | "reviewDigest" | "generic" };

export interface IntentVaultAuthority {
  /** Exact current inventory admission, availability and unlock authority. */
  isAdmittedAndUnlocked(vault: OpenVault): boolean;
}

export async function resolveNotificationIntent(
  ledger: NotificationIntentLedger,
  stores: HostStores,
  authority: IntentVaultAuthority,
  requestId: string,
  intentToken: string,
  now: () => number,
): Promise<NotificationTarget | null> {
  const intent = ledger.resolve(requestId, intentToken);
  if (intent === null) return null;
  /** A click is one-use even when the target later proves stale or unavailable. */
  if (!ledger.consume(requestId, intentToken)) return null;
  const vault = stores.vaults.get(intent.vaultId);
  if (
    vault === undefined ||
    !authority.isAdmittedAndUnlocked(vault) ||
    (vault.native !== undefined && !vault.native.isCurrent())
  )
    return null;
  if (intent.kind !== "signal") return { vaultId: vault.id, kind: intent.kind };
  const signalId = intent.signalId;
  if (signalId === undefined) return null;
  return vault.queue.run(() => {
    if (
      stores.vaults.get(vault.id) !== vault ||
      !authority.isAdmittedAndUnlocked(vault) ||
      (vault.native !== undefined && !vault.native.isCurrent())
    )
      return null;
    const read = vault.store.read.bind(vault.store);
    const signal = signalByGid(read, signalId);
    if (
      signal === undefined ||
      signal.status !== "active" ||
      (signal.snoozedUntil !== null && Date.parse(signal.snoozedUntil) > now()) ||
      views.hiddenFromOwner(signal) ||
      decisions(read, { signal: signalId }).length !== 0
    )
      return null;
    return { vaultId: vault.id, kind: "signal" as const, signalId };
  });
}
