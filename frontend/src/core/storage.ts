// Browser storage keys are `cashu.*`. Before the rename (legacy name) they were `finanse.*`: a read
// that finds only the old key moves its value to the new key once (write new, drop old) and returns it.
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const KEY_PREFIX = "cashu.";
export const LEGACY_KEY_PREFIX = "finanse."; // legacy name

/** The old key of a `cashu.*` key (`cashu.theme` -> `finanse.theme`), else null. */
export const legacyKey = (key: string): string | null =>
  key.startsWith(KEY_PREFIX) ? LEGACY_KEY_PREFIX + key.slice(KEY_PREFIX.length) : null;

/** `storage.getItem(key)` with the one-time fallback to the pre-rename key. Never throws. */
export function readStored(storage: StorageLike | null | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    if (value !== null) return value;
    const old = legacyKey(key);
    if (old === null) return null;
    const legacy = storage.getItem(old);
    if (legacy === null) return null;
    try { storage.setItem(key, legacy); storage.removeItem(old); } catch { /* quota / private mode: keep the old one */ }
    return legacy;
  } catch {
    return null;
  }
}
