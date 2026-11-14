// The pairing's ports over the running services: this build's relay client (the identity every paired
// vault syncs with), the vaults this phone already holds, and the storing steps (`storeJoinedPairing`
// under the vault's queue, then `addPairedVault`, which reopens the services).
import {
  addPairedVault,
  phoneRelay,
  phoneSodium,
  type Services,
  storeJoinedPairing,
} from "../../services/services";
import type { PairingPorts } from "./joiner";
import { S } from "./Pair.strings";

export function pairingPorts(services: Services): PairingPorts {
  return {
    sodium: phoneSodium(),
    relay: phoneRelay(),
    now: () => Date.now(),
    held: (vault) => {
      const session = services.vaults.get(vault);
      if (session === undefined) return undefined;
      const name = services.profiles.find((p) => p.vault === vault)?.name ?? vault;
      return { name, unpushed: session.status().unpushed };
    },
    pushHeld: async (vault) => {
      const session = services.vaults.get(vault);
      if (session === undefined) return false;
      await session.pass("push");
      return session.status().unpushed;
    },
    store: (joined, options) => storeJoinedPairing(joined, options),
    add: (entry) => addPairedVault(entry),
    placeholderName: S.newProfile,
  };
}
