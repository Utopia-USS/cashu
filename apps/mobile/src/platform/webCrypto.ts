// Hermes has no Web Crypto: `crypto.getRandomValues` (which @noble/hashes' randomBytes calls for the
// store's ULIDs and vault salts) comes from expo-crypto (the OS CSPRNG), installed once at startup.
import { getRandomValues } from "expo-crypto";

export function installWebCryptoRandom(): void {
  const g = globalThis as { crypto?: { getRandomValues?: unknown } };
  if (typeof g.crypto?.getRandomValues === "function") return;
  g.crypto = { ...g.crypto, getRandomValues };
}
