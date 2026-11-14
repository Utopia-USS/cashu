// The one helper every production fetch path (worker jobs, CLI daily, market transport, MCP calls,
// owner bank / connector / classifier actions) uses to obtain fresh lease pull evidence before it
// checks fetch authority. See nativeVault/fetchAuthority.ts for the rule it follows.
import type { OpenVault } from "./stores.js";

/**
 * Refreshes the vault's pull evidence when it is stale (one queued sync pass, only for the named
 * fetch leader) and answers whether the vault may fetch now. Never throws; a synthetic vault or a
 * session without the capability answers false and leaves the caller's own check unchanged.
 * Never await it inside the vault's write queue.
 */
export async function refreshFetchAuthority(vault: OpenVault | undefined): Promise<boolean> {
  if (vault?.mode !== "native") return false;
  try {
    return (await vault.native.refreshFetchAuthority()) === true;
  } catch {
    return false;
  }
}

/** The same for several vaults at once (one shared market request serves all of them). */
export async function refreshFetchAuthorities(
  vaults: Iterable<OpenVault | undefined>,
): Promise<void> {
  await Promise.all([...vaults].map((vault) => refreshFetchAuthority(vault)));
}

/** Status only: why the vault may not fetch now (nativeVault/fetchAuthority.ts), else null. */
export function fetchAuthorityIssue(vault: OpenVault | undefined): string | null {
  if (vault?.mode !== "native") return "fetch_session_unavailable";
  try {
    return vault.native.fetchAuthorityIssue();
  } catch {
    return "fetch_authority_unavailable";
  }
}

/** Status only: may fetch now, or would after the refresh above. Never throws. */
export function mayObtainFetchAuthority(vault: OpenVault | undefined): boolean {
  if (vault?.mode !== "native") return false;
  try {
    return vault.native.mayObtainFetchAuthority() === true;
  } catch {
    return false;
  }
}
