// Where the host finds the sync relay's public web config (M4-C section 4). The config holds public
// identifiers (project id, web API key, app id, auth domain) but is kept out of this repository, so it
// comes from a file at run time:
//   - a packaged app: `<data dir>/relay/firebase.json` only (a Finder-launched app has no shell env),
//   - a host from a checkout: `CASHU_FIREBASE_CONFIG=<absolute path>` first, else the data-dir file;
//     `CASHU_FIRESTORE_EMULATOR_HOST` + `CASHU_FIREBASE_AUTH_EMULATOR_HOST` (loopback only) switch the
//     endpoints to the local emulators (the `demo-cashu` project when no config file is given).
// No config: every relay surface is hidden and every relay RPC refused `no_config`. The loader never
// logs or returns a value of the file in an error: only a fixed code.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FirestoreEndpoint, IdentityEndpoint } from "@cashu/sync";
import { z } from "zod";

const MAX_CONFIG_BYTES = 16 * 1024;
const EMULATOR_PROJECT = "demo-cashu";
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/;

/**
 * The web config shape (a pasted Firebase snippet may carry more keys: they are dropped). Patterns
 * keep a value from ever being a path, a URL or a script.
 */
const relayConfigSchema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  apiKey: z.string().regex(/^[A-Za-z0-9_-]{10,128}$/),
  appId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
  authDomain: z.string().regex(/^[a-z0-9.-]{1,253}$/),
});

type RelayConfig = z.infer<typeof relayConfigSchema>;

/** A usable relay: the project the vault documents live in and the two REST endpoints. */
export interface RelayEndpoints {
  readonly projectId: string;
  readonly firestore: FirestoreEndpoint;
  readonly identity: IdentityEndpoint;
  /** "emulator" when the endpoints point at the local Firebase emulators. */
  readonly target: "firebase" | "emulator";
}

export type RelayConfigResult =
  | { readonly kind: "ready"; readonly relay: RelayEndpoints }
  | { readonly kind: "absent" }
  /** A file exists but is unreadable or does not have the shape (value-free code). */
  | { readonly kind: "invalid"; readonly code: RelayConfigIssue };

type RelayConfigIssue =
  | "relay_config_path_invalid"
  | "relay_config_unreadable"
  | "relay_config_too_large"
  | "relay_config_malformed"
  | "relay_emulator_host_invalid";

export interface RelayConfigInput {
  readonly dataDir: string;
  /** The packaged app reads only the data-dir file; env overrides are for a checkout. */
  readonly packaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Test seam: the file's bytes, undefined when it does not exist. */
  readonly readFile?: (path: string) => Uint8Array | undefined;
}

/** `<data dir>/relay/firebase.json`, the owner-placed config of a packaged app. */
export const relayConfigFile = (dataDir: string) => join(dataDir, "relay", "firebase.json");

export function loadRelayConfig(input: RelayConfigInput): RelayConfigResult {
  const env = input.packaged ? {} : input.env;
  const override = env.CASHU_FIREBASE_CONFIG;
  if (override !== undefined && override !== "" && !isAbsolute(override))
    return { kind: "invalid", code: "relay_config_path_invalid" };
  const path =
    override !== undefined && override !== "" ? override : relayConfigFile(input.dataDir);
  const emulator = emulatorHosts(env);
  if (emulator === "invalid") return { kind: "invalid", code: "relay_emulator_host_invalid" };
  let bytes: Uint8Array | undefined;
  try {
    bytes = (input.readFile ?? readConfigFile)(path);
  } catch (error) {
    return {
      kind: "invalid",
      code:
        error instanceof Error && error.message === "relay_config_too_large"
          ? "relay_config_too_large"
          : "relay_config_unreadable",
    };
  }
  let config: RelayConfig | undefined;
  if (bytes !== undefined) {
    if (bytes.length > MAX_CONFIG_BYTES) return { kind: "invalid", code: "relay_config_too_large" };
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { kind: "invalid", code: "relay_config_malformed" };
    }
    const parsed = relayConfigSchema.safeParse(raw);
    if (!parsed.success) return { kind: "invalid", code: "relay_config_malformed" };
    config = parsed.data;
  }
  if (emulator !== undefined) {
    const projectId = config?.projectId ?? EMULATOR_PROJECT;
    return {
      kind: "ready",
      relay: {
        projectId,
        target: "emulator",
        firestore: { projectId, baseUrl: `http://${emulator.firestore}` },
        identity: {
          apiKey: config?.apiKey ?? "emulator-key",
          baseUrl: `http://${emulator.auth}/identitytoolkit.googleapis.com`,
          tokenBaseUrl: `http://${emulator.auth}/securetoken.googleapis.com`,
        },
      },
    };
  }
  if (config === undefined) return { kind: "absent" };
  return {
    kind: "ready",
    relay: {
      projectId: config.projectId,
      target: "firebase",
      firestore: { projectId: config.projectId },
      identity: { apiKey: config.apiKey },
    },
  };
}

function emulatorHosts(
  env: Readonly<Record<string, string | undefined>>,
): { readonly firestore: string; readonly auth: string } | "invalid" | undefined {
  const firestore = env.CASHU_FIRESTORE_EMULATOR_HOST;
  const auth = env.CASHU_FIREBASE_AUTH_EMULATOR_HOST;
  if (!firestore && !auth) return undefined;
  if (!firestore || !auth || !LOOPBACK_HOST.test(firestore) || !LOOPBACK_HOST.test(auth))
    return "invalid";
  return { firestore, auth };
}

/** The file's bytes (a regular file, at most 16 KiB), undefined when it does not exist. */
function readConfigFile(path: string): Uint8Array | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("relay_config_unreadable");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("relay_config_unreadable");
    if (stat.size > MAX_CONFIG_BYTES) throw new Error("relay_config_too_large");
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return new Uint8Array(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}
