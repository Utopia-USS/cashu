// The production host's relay wiring (main.ts -> productionRelayOptions): a bad config file is one
// value-free stderr line and no relay (`no_config`); a test build takes the emulators only; a keychain
// that cannot be reached fails relay requests (`offline`), never the host start. Synthetic values only;
// the hosts run against the in-memory fake (`demo-cashu`).
import type { RelayAuthSecret } from "@cashu/node-host/relay-auth";
import { afterEach, expect, it } from "vitest";
import { presetRelaySetting, relayHarness, relayRequests, until } from "../testing/relayFixture.js";
import { relayConfigFile } from "./config.js";
import { productionRelayOptions } from "./production.js";
import type { HostRelayOptions } from "./service.js";

const harness = relayHarness();
afterEach(() => harness.cleanup());

const DATA_DIR = "/synthetic/data-dir";
const SYNTHETIC = JSON.stringify({
  projectId: "synthetic-project",
  apiKey: "AIzaSynthetic000000000000000000000000000",
  appId: "1:000000000000:web:0000000000000000",
  authDomain: "synthetic-project.example.test",
});
const EMULATORS = {
  CASHU_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  CASHU_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
};
const bytes = (text: string) => new TextEncoder().encode(text);

function wiring(input: {
  readonly file?: string;
  readonly env?: Record<string, string>;
  readonly testBuild?: boolean;
  readonly secret?: () => RelayAuthSecret;
}) {
  const stderr: string[] = [];
  const read: string[] = [];
  const options = productionRelayOptions({
    dataDir: DATA_DIR,
    packaged: false,
    testBuild: input.testBuild ?? false,
    env: input.env ?? {},
    stderr: (line) => stderr.push(line),
    readFile: (path) => {
      read.push(path);
      return input.file === undefined ? undefined : bytes(input.file);
    },
    ...(input.secret === undefined ? {} : { secret: input.secret }),
  });
  return { options, stderr, read };
}

it("runs without a relay when the config is absent or malformed, naming only a code", () => {
  expect(wiring({})).toMatchObject({ options: undefined, stderr: [] });
  const malformed = wiring({ file: '{"projectId": "synthetic-project", "apiKey": 42}' });
  expect(malformed.options).toBeUndefined();
  expect(malformed.stderr).toEqual(["cashu-host: relay_config_malformed"]);
  const relative = wiring({ env: { CASHU_FIREBASE_CONFIG: "relative/firebase.json" } });
  expect(relative.stderr).toEqual(["cashu-host: relay_config_path_invalid"]);
  const ready = wiring({ file: SYNTHETIC });
  expect(ready.options?.endpoints).toMatchObject({
    projectId: "synthetic-project",
    target: "firebase",
  });
});

it("gives a test build the emulators only, never a configured project", () => {
  const exported = wiring({
    testBuild: true,
    env: { CASHU_FIREBASE_CONFIG: "/synthetic/elsewhere/firebase.json" },
    file: SYNTHETIC,
  });
  expect(exported.read).toEqual([relayConfigFile(DATA_DIR)]);
  expect(exported.options).toBeUndefined();
  const emulator = wiring({ testBuild: true, env: EMULATORS });
  expect(emulator.options?.endpoints).toMatchObject({
    projectId: "demo-cashu",
    target: "emulator",
  });
});

/** Emulator-shaped options from the wiring, served by the env's fake on its virtual clock. */
function overFake(
  env: Awaited<ReturnType<typeof harness.setup>>,
  secret: () => RelayAuthSecret,
): HostRelayOptions {
  const options = wiring({ env: EMULATORS, secret }).options;
  if (options === undefined) throw new Error("no relay options");
  return { ...options, fetch: env.fake.fetch, retries: 0, timers: env.timers, now: env.timers.now };
}

const LOCKED: readonly [string, () => RelayAuthSecret][] = [
  [
    "a keychain the host cannot open",
    () => {
      throw new Error("relay_auth_unavailable");
    },
  ],
  [
    "a keychain that refuses the read",
    () => ({
      get: () => Promise.reject(new Error("relay_auth_unavailable")),
      set: () => Promise.reject(new Error("relay_auth_unavailable")),
      clear: () => Promise.reject(new Error("relay_auth_unavailable")),
    }),
  ],
];

it.each(LOCKED)("starts and answers offline with %s", async (_case, secret) => {
  const env = await harness.setup();
  // A vault already switched on: its remote is built at open and its first pass runs at start.
  presetRelaySetting(env.fixture.dataDir, env.vault, {
    enabled: true,
    project: "demo-cashu",
    enabledAt: env.timers.now(),
    memberUids: {},
  });
  const host = await env.start(overFake(env, secret));
  env.timers.advance(0);
  await until(() => host.relay.pending() === 0);
  expect(host.relay.status(env.vault)).toMatchObject({ configured: true, enabled: true });
  expect(await host.relay.enable(env.vault)).toEqual({
    result: { kind: "refused", reason: "offline" },
    reopen: false,
  });
  expect(relayRequests(env.fake)).toBe(0);
  expect(await host.stop("idle")).toBe(0);
});
