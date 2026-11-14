// Test helpers for host suites that run against the Firebase emulators (Firestore + Auth) with the real
// security rules (`firestore.rules`): the hosts from the variables `firebase emulators:exec` exports
// (without them the suites skip), endpoints of the `demo-cashu` project only (a `demo-` id runs offline,
// never a real project), a fresh named database per suite, and a raw read of every document under a
// vault through the emulator's admin bypass (`Authorization: Bearer owner`, rules skipped) for the
// oracles. The code under test always uses its own anonymous identities.
import type { FirestoreEndpoint, IdentityEndpoint } from "@cashu/sync";
import type { RelayEndpoints } from "../relay/config.js";

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

/** A fresh database name of the emulator's project (created on first use, isolated from other suites). */
export function emulatorDatabase(prefix: string): string {
  return `${prefix}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

export function emulatorFirestore(hosts: EmulatorHosts, database: string): FirestoreEndpoint {
  return { projectId: EMULATOR_PROJECT, baseUrl: `http://${hosts.firestore}`, database };
}

export function emulatorIdentityEndpoint(hosts: EmulatorHosts): IdentityEndpoint {
  return {
    apiKey: "emulator-key",
    baseUrl: `http://${hosts.auth}/identitytoolkit.googleapis.com`,
    tokenBaseUrl: `http://${hosts.auth}/securetoken.googleapis.com`,
  };
}

/** The host's relay endpoints on the emulators (`target: "emulator"`, project `demo-cashu`). */
export function emulatorRelayEndpoints(hosts: EmulatorHosts, database: string): RelayEndpoints {
  return {
    projectId: EMULATOR_PROJECT,
    target: "emulator",
    firestore: emulatorFirestore(hosts, database),
    identity: emulatorIdentityEndpoint(hosts),
  };
}

/** One document as the emulator stores it: its path below `documents/` and its raw REST JSON. */
export interface RawDocument {
  readonly path: string;
  readonly fields: Readonly<Record<string, Record<string, unknown>>>;
  /** The document's REST JSON exactly as the emulator answered it. */
  readonly json: string;
}

async function ownerGet(url: string, init: { method?: string; body?: string } = {}) {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`emulator owner read ${response.status}`);
  return text;
}

/**
 * Every document at or below `vaults/<vault>` (the vault document, members, recoveries, segments and
 * their chunks, pairings and their messages, and any collection nobody expected), read as the
 * rules-bypassing owner, collection by collection.
 */
export async function rawVaultDocuments(
  hosts: EmulatorHosts,
  database: string,
  vault: string,
): Promise<RawDocument[]> {
  const base = `http://${hosts.firestore}/v1/projects/${EMULATOR_PROJECT}/databases/${encodeURIComponent(database)}/documents`;
  const out: RawDocument[] = [];
  const visit = async (path: string, json: string | undefined) => {
    if (json !== undefined) {
      const doc = JSON.parse(json) as { fields?: RawDocument["fields"] };
      out.push({ path, fields: doc.fields ?? {}, json });
    }
    const ids = JSON.parse(
      await ownerGet(`${base}/${path}:listCollectionIds`, { method: "POST", body: "{}" }),
    ) as { collectionIds?: string[] };
    for (const collection of ids.collectionIds ?? []) {
      let pageToken: string | undefined;
      do {
        const query = `pageSize=300&showMissing=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const page = JSON.parse(await ownerGet(`${base}/${path}/${collection}?${query}`)) as {
          documents?: { name: string; fields?: unknown; createTime?: string }[];
          nextPageToken?: string;
        };
        for (const document of page.documents ?? []) {
          const child = document.name.slice(document.name.indexOf("/documents/") + 11);
          // `showMissing` lists a path that only has subcollections without a body (no createTime).
          await visit(
            child,
            document.createTime === undefined ? undefined : JSON.stringify(document),
          );
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
  };
  const root = `vaults/${vault}`;
  let rootJson: string | undefined;
  try {
    rootJson = await ownerGet(`${base}/${root}`);
  } catch {
    rootJson = undefined;
  }
  await visit(root, rootJson);
  return out;
}
