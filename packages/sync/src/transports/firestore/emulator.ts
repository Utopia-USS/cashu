// Test helper for the Firebase emulators (Firestore + Auth), used by the `*.emulator.test.ts` suites.
// The hosts come from the variables `firebase emulators:exec` exports; without them the suites skip.
// Only the `demo-cashu` project id is ever used (a `demo-` id runs offline, no login, no real project).
// Seeding and cleanup go through the emulator's admin bypass (`Authorization: Bearer owner`), which
// skips the security rules; the code under test always uses its own anonymous identities.
import type { IdentityEndpoint } from "./auth.js";
import { type FirestoreEndpoint, FirestoreRest, type TokenSource } from "./rest.js";

const EMULATOR_PROJECT = "demo-cashu";

export interface EmulatorHosts {
  /** "127.0.0.1:8080" (FIRESTORE_EMULATOR_HOST). */
  readonly firestore: string;
  /** "127.0.0.1:9099" (FIREBASE_AUTH_EMULATOR_HOST). */
  readonly auth: string;
}

/** The emulator hosts from the environment, or undefined when the emulators are not running. */
export function emulatorHosts(): EmulatorHosts | undefined {
  const firestore = process.env.FIRESTORE_EMULATOR_HOST;
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  return firestore && auth ? { firestore, auth } : undefined;
}

/** The emulator's `demo-cashu` project; `database` names a separate database (created on first use). */
export function emulatorEndpoint(hosts: EmulatorHosts, database?: string): FirestoreEndpoint {
  return {
    projectId: EMULATOR_PROJECT,
    baseUrl: `http://${hosts.firestore}`,
    ...(database ? { database } : {}),
  };
}

export function emulatorIdentity(hosts: EmulatorHosts): IdentityEndpoint {
  return {
    apiKey: "emulator-key",
    baseUrl: `http://${hosts.auth}/identitytoolkit.googleapis.com`,
    tokenBaseUrl: `http://${hosts.auth}/securetoken.googleapis.com`,
  };
}

const OWNER: TokenSource = { token: () => Promise.resolve("owner") };

/** A request to the Firestore emulator as the rules-bypassing owner; `path` starts with "/". */
function ownerFetch(hosts: EmulatorHosts, path: string, method: string): Promise<Response> {
  return fetch(`http://${hosts.firestore}${path}`, {
    method,
    headers: { authorization: "Bearer owner" },
  });
}

/** A REST client that seeds and inspects documents as the owner (security rules skipped). */
export function ownerRest(hosts: EmulatorHosts, database?: string): FirestoreRest {
  return new FirestoreRest({
    endpoint: emulatorEndpoint(hosts, database),
    auth: OWNER,
    retries: 0,
  });
}

/** Deletes every document of one database (default "(default)") of the emulator's `demo-cashu` project. */
export async function clearData(hosts: EmulatorHosts, database = "(default)"): Promise<void> {
  const response = await ownerFetch(
    hosts,
    `/emulator/v1/projects/${EMULATOR_PROJECT}/databases/${encodeURIComponent(database)}/documents`,
    "DELETE",
  );
  await response.body?.cancel();
  if (!response.ok) throw new Error(`emulator clearData ${response.status}`);
}
