// Test helpers (synthetic data only). Not exported from the package.

import { utf8 } from "./encoding.js";
import type { FrameContext } from "./frame.js";
import { loadNodeSodium, type Sodium } from "./sodium.js";

export const sodium: Sodium = await loadNodeSodium();

export const PLAINTEXT_MARKER = "SYNTHETIC-CANARY-merchant-7f3a";

export function samplePlain(): Uint8Array {
  return utf8(JSON.stringify([{ t: "merchant.category.set", v: 1, merchant: PLAINTEXT_MARKER }]));
}

export function ctx(vaultId: string, over: Partial<FrameContext> = {}): FrameContext {
  return { vaultId, deviceId: "device-a", segment: 3, offset: 4096, ...over };
}

export function range(from: number, to: number): Uint8Array {
  return Uint8Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
