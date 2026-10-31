// The acceptance policy for keys that arrive from outside (an unwrapped payload, a stored ring):
// bounds on generations and epochs, no generation or epoch gap, a per-generation cap, all or
// nothing. `Keyring.merge` applies it after checking vault id, recovery keys and gid salt.

import { CryptoError } from "./errors.js";
import type { RecoveryPublicKeys } from "./identity.js";
import { inBounds, type KeyEntry, MAX_GENERATION } from "./keyEntry.js";

/** Keys one generation may hold (devices that rotated concurrently); more is a flood, `bad_payload`. */
export const MAX_KEYS_PER_GENERATION = 8;
/** Consistent with the bounds above, so every ring `merge` accepts can be saved and wrapped. */
export const MAX_KEYS = MAX_GENERATION * MAX_KEYS_PER_GENERATION;

export function samePublicKeys(a: RecoveryPublicKeys, b: RecoveryPublicKeys): boolean {
  return equalBytes(a.boxPublicKey, b.boxPublicKey) && equalBytes(a.signPublicKey, b.signPublicKey);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The new keys of `incoming` (ascending (generation, epoch, kid)) that may join `held`: each
 * generation at most one above the highest held so far (`generation_gap`), each epoch at most one
 * above the highest held (`epoch_gap`; an empty ring takes its first key's epoch as the base), at
 * most `MAX_KEYS_PER_GENERATION` keys per generation and every key in bounds (`bad_payload`).
 * Throws on the first violation, so the caller adds nothing.
 */
export function selectAcceptedKeys(
  held: readonly KeyEntry[],
  incoming: readonly KeyEntry[],
): KeyEntry[] {
  const heldKids = new Set(held.map((e) => e.kid));
  let max = 0;
  for (const e of held) max = Math.max(max, e.generation);
  // An empty ring takes its first key's epoch as the base (pairing / recovery initial load).
  let maxEpoch: number | undefined;
  for (const e of held) maxEpoch = Math.max(maxEpoch ?? 0, e.epoch);
  const perGeneration = new Map<number, number>();
  for (const e of held) {
    perGeneration.set(e.generation, (perGeneration.get(e.generation) ?? 0) + 1);
  }
  const fresh: KeyEntry[] = [];
  for (const e of incoming) {
    if (!inBounds(e.generation, e.epoch)) throw new CryptoError("bad_payload");
    if (heldKids.has(e.kid)) continue;
    if (e.generation > max + 1) throw new CryptoError("generation_gap");
    if (maxEpoch !== undefined && e.epoch > maxEpoch + 1) throw new CryptoError("epoch_gap");
    const inGeneration = (perGeneration.get(e.generation) ?? 0) + 1;
    if (inGeneration > MAX_KEYS_PER_GENERATION) throw new CryptoError("bad_payload");
    perGeneration.set(e.generation, inGeneration);
    max = Math.max(max, e.generation);
    maxEpoch = Math.max(maxEpoch ?? e.epoch, e.epoch);
    fresh.push(e);
  }
  return fresh;
}
