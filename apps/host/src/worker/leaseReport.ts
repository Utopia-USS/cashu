import type { OpenVault } from "../stores.js";

/** Lease activity is an independent durable report after a completed external fetch. */
export async function reportSuccessfulFetch(vault: OpenVault, guard: () => void): Promise<void> {
  if (vault.mode !== "native") return;
  try {
    guard();
    const result = await vault.native.recordFetch();
    if (result !== "completed") console.warn(`cashu-host: fetch lease report ${result}`);
  } catch {
    // The financial fetch has already committed. Keep its outcome and surface only this report gap.
    console.warn("cashu-host: fetch lease report unavailable");
  }
}
