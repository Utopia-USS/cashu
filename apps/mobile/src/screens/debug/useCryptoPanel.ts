// Screen hook of the crypto panel: suspends once on the self-test, which runs after the first frame,
// so the store data of the debug screen shows without waiting for it.
import { use } from "react";
import { useServices } from "../../services/ServicesProvider";
import type { CryptoViewProps } from "./CryptoView";

const webCryptoRandom =
  typeof (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto?.getRandomValues ===
  "function";

export function useCryptoPanel(): CryptoViewProps {
  const result = use(useServices().cryptoSelfTest);
  return { ...result, webCryptoRandom };
}
