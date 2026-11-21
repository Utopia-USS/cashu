// The sync relay's Firebase web config, inlined by Metro at bundle time. Four plain variables
// (`EXPO_PUBLIC_FIREBASE_PROJECT_ID`, `_API_KEY`, `_APP_ID`, `_AUTH_DOMAIN`) are the primary form; the
// JSON `EXPO_PUBLIC_FIREBASE_CONFIG` is still read when it parses. The JSON form is fragile in a
// `.env*` file: Expo parses those with Node's `util.parseEnv`, which ends a double-quoted value at the
// first `"` even when it is escaped, so `"{\"projectId\":...}"` arrives as `{\`. Plain values need
// no quoting. A dev build (`__DEV__`) also reads `EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST` and
// `EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` (loopback only, both or neither) and then talks to the
// local Firebase emulators, as the host does with its `CASHU_*` pair (`demo-cashu` without a
// project); a release build ignores them. Absent or not decodable: undefined, and every relay
// surface stays off. The values are public client identifiers, still never logged.
import type { FirestoreEndpoint, IdentityEndpoint } from "@cashu/sync/engine";
import { z } from "zod";

const webConfigSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9-]{4,40}$/u),
  apiKey: z.string().min(1).max(200),
  appId: z.string().min(1).max(200),
  authDomain: z.string().min(1).max(200),
});

/** The Firebase web config as the project's console gives it. */
export type WebConfig = z.infer<typeof webConfigSchema>;

/** A usable relay: the project the vault documents live in and the two REST endpoints. */
export interface RelayConfig {
  readonly projectId: string;
  readonly firestore: FirestoreEndpoint;
  readonly identity: IdentityEndpoint;
  /** "emulator" when the endpoints point at the local Firebase emulators (dev builds only). */
  readonly target: "firebase" | "emulator";
}

/** The raw build variables (each undefined when unset). */
export interface RelayEnv {
  readonly projectId?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly appId?: string | undefined;
  readonly authDomain?: string | undefined;
  /** The JSON form, read when the plain variables are not all set. */
  readonly json?: string | undefined;
  readonly firestoreEmulatorHost?: string | undefined;
  readonly authEmulatorHost?: string | undefined;
}

const EMULATOR_PROJECT = "demo-cashu";
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/u;

/** Decode one raw JSON config string; undefined when it is missing, not JSON or not the expected shape. */
export function parseRelayConfig(raw: string | undefined): WebConfig | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed = webConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The web config from the four plain variables, else from the JSON one. */
function webConfig(env: RelayEnv): WebConfig | undefined {
  const plain = webConfigSchema.safeParse({
    projectId: env.projectId?.trim(),
    apiKey: env.apiKey?.trim(),
    appId: env.appId?.trim(),
    authDomain: env.authDomain?.trim(),
  });
  return plain.success ? plain.data : parseRelayConfig(env.json);
}

/**
 * This build's relay from its variables. `dev` is `__DEV__`: only a dev build honours the emulator
 * hosts. Emulator hosts that are half set or not loopback turn the relay off (never a silent fallback
 * to the real project from a build meant for the emulator).
 */
export function resolveRelayConfig(env: RelayEnv, dev: boolean): RelayConfig | undefined {
  const config = webConfig(env);
  const firestoreHost = dev ? env.firestoreEmulatorHost?.trim() : undefined;
  const authHost = dev ? env.authEmulatorHost?.trim() : undefined;
  if (firestoreHost || authHost) {
    if (!firestoreHost || !authHost) return undefined;
    if (!LOOPBACK_HOST.test(firestoreHost) || !LOOPBACK_HOST.test(authHost)) return undefined;
    const projectId = config?.projectId ?? EMULATOR_PROJECT;
    return {
      projectId,
      target: "emulator",
      firestore: { projectId, baseUrl: `http://${firestoreHost}` },
      identity: {
        apiKey: config?.apiKey ?? "emulator-key",
        baseUrl: `http://${authHost}/identitytoolkit.googleapis.com`,
        tokenBaseUrl: `http://${authHost}/securetoken.googleapis.com`,
      },
    };
  }
  if (config === undefined) return undefined;
  return {
    projectId: config.projectId,
    target: "firebase",
    firestore: { projectId: config.projectId },
    identity: { apiKey: config.apiKey },
  };
}

let cached: { readonly value: RelayConfig | undefined } | undefined;

/** This build's relay config (read once per launch). */
export function relayConfig(): RelayConfig | undefined {
  // Each literal `process.env.EXPO_PUBLIC_*` member is what Metro replaces at bundle time: never
  // read them through a computed key or a destructured `process.env`.
  cached ??= {
    value: resolveRelayConfig(
      {
        projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
        apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
        appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
        authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
        json: process.env.EXPO_PUBLIC_FIREBASE_CONFIG,
        firestoreEmulatorHost: process.env.EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST,
        authEmulatorHost: process.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST,
      },
      __DEV__,
    ),
  };
  return cached.value;
}
