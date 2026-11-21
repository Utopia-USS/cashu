// The companion demo's vaults. TRANSITIONAL(S44): every build holds only the fixture's demo vaults until
// pairing brings real ones; the demo keeps its seeded prices and starts without the app lock.
import { COMPANION_VAULTS } from "../fixture/companionDemo";

/** One of the fixture's demo vaults (synthetic data). */
export function isDemoVault(vault: string): boolean {
  return vault === COMPANION_VAULTS.anna.vault || vault === COMPANION_VAULTS.home.vault;
}
