// Test-only helpers, exported from the `@cashu/sync/testing` subpath and never from the main entry,
// so the app cannot wire an in-memory key store by accident.

import { keyringFromKeys } from "./keyring.js";
import { checkName, type KeyStore } from "./keystore.js";

export { keyringFromKeys };

/** Keeps values in memory only. For tests; never for a real device. */
export class InMemoryKeyStore implements KeyStore {
  #items = new Map<string, Uint8Array>();

  async get(name: string): Promise<Uint8Array | null> {
    checkName(name);
    const v = this.#items.get(name);
    return v ? v.slice() : null;
  }

  async set(name: string, value: Uint8Array): Promise<void> {
    checkName(name);
    this.#items.get(name)?.fill(0);
    this.#items.set(name, value.slice());
  }

  async delete(name: string): Promise<void> {
    checkName(name);
    this.#items.get(name)?.fill(0);
    this.#items.delete(name);
  }
}
