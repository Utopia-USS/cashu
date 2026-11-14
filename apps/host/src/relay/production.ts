// The production host's relay wiring (main.ts): the config of this data dir (relay/config.ts) and the
// identity in the OS keychain (@cashu/node-host/relay-auth). A bad config file is reported by its code
// only and leaves the host without a relay (`no_config`); a keychain that cannot be reached is touched
// only on the first relay request (service.ts builds the auth store lazily), so it fails that request
// (`offline`) and never the host start. A test build (e2e) takes the local emulators only: a config
// that names a real project never reaches it, whatever the shell exported.
import type { HostLock } from "@cashu/node-host";
import { createProductionRelayAuthSecret, type RelayAuthSecret } from "@cashu/node-host/relay-auth";
import { secretAuthStore } from "./auth.js";
import { loadRelayConfig, type RelayConfigInput } from "./config.js";
import type { HostRelayOptions } from "./service.js";

export interface ProductionRelayInput {
  readonly dataDir: string;
  /** The packaged app reads only the data-dir file; env overrides are for a checkout. */
  readonly packaged: boolean;
  /** A test build of the app (its marker): emulator endpoints only. */
  readonly testBuild: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: (line: string) => void;
  /** Test seam: the keychain secret of the data dir (default: the OS keychain). */
  readonly secret?: (authority: {
    readonly dataDir: string;
    readonly lock: HostLock;
  }) => RelayAuthSecret;
  /** Test seam: the config file's bytes. */
  readonly readFile?: RelayConfigInput["readFile"];
}

/** The relay options of a production host, or undefined when it runs without a relay. */
export function productionRelayOptions(input: ProductionRelayInput): HostRelayOptions | undefined {
  const { CASHU_FIREBASE_CONFIG: _realConfig, ...emulatorOnly } = input.env;
  const config = loadRelayConfig({
    dataDir: input.dataDir,
    packaged: input.packaged,
    env: input.testBuild ? emulatorOnly : input.env,
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
  });
  if (config.kind === "invalid") {
    input.stderr(`cashu-host: ${config.code}`);
    return undefined;
  }
  if (config.kind === "absent") return undefined;
  if (input.testBuild && config.relay.target !== "emulator") return undefined;
  const secret = input.secret ?? createProductionRelayAuthSecret;
  return {
    endpoints: config.relay,
    authStore: (lock) => secretAuthStore(secret({ dataDir: input.dataDir, lock })),
  };
}
