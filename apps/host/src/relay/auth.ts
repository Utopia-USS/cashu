// The Mac host's relay identity (M4-C section 1): one anonymous uid per data dir, shared by every vault,
// its refresh token kept by a secret port (the OS keychain in production, `@cashu/node-host/relay-auth`;
// a memory store in tests). A stored record that does not decode reads as absent (a fresh sign-up).

import type { RelayAuthSecret } from "@cashu/node-host/relay-auth";
import {
  AnonymousAuth,
  type AuthRecord,
  type AuthStore,
  type FirestoreRestOptions,
  type IdentityEndpoint,
} from "@cashu/sync";
import { z } from "zod";

/** The `fetch` the relay clients take (`globalThis.fetch` and the test fake satisfy it). */
export type RelayFetch = NonNullable<FirestoreRestOptions["fetch"]>;

const recordSchema = z.strictObject({
  uid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  refreshToken: z.string().min(1).max(8_192),
});

/** An `AuthStore` over one string secret, JSON encoded. */
export function secretAuthStore(secret: RelayAuthSecret): AuthStore {
  return {
    async load(): Promise<AuthRecord | undefined> {
      const raw = await secret.get();
      if (raw === null) return undefined;
      try {
        const parsed = recordSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    async save(record) {
      await secret.set(JSON.stringify({ uid: record.uid, refreshToken: record.refreshToken }));
    },
    async clear() {
      await secret.clear();
    },
  };
}

/** The data dir's anonymous identity at the relay. */
export function relayIdentity(input: {
  readonly endpoint: IdentityEndpoint;
  readonly store: AuthStore;
  readonly fetch?: RelayFetch;
  readonly now: () => number;
  /** The previous uid's memberships are stale (the service marks every enabled vault). */
  readonly onIdentityLost: () => void;
}): AnonymousAuth {
  return new AnonymousAuth({
    endpoint: input.endpoint,
    store: input.store,
    now: input.now,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    onIdentityLost: () => input.onIdentityLost(),
  });
}
