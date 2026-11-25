// The relay config loader: file locations per build kind, the emulator switch, refusal codes that never
// carry a value of the file. Only synthetic values (never the real project's config).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadRelayConfig, relayConfigFile } from "./config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-relay-config-")));
  dirs.push(dir);
  return dir;
}

const SYNTHETIC = {
  projectId: "synthetic-project",
  apiKey: "AIzaSynthetic000000000000000000000000000",
  appId: "1:000000000000:web:0000000000000000",
  authDomain: "synthetic-project.example.test",
  storageBucket: "extra keys of a pasted snippet are dropped",
};

function place(dir: string, value: unknown): string {
  const path = relayConfigFile(dir);
  mkdirSync(join(dir, "relay"), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
}

it("is absent without a file and reads the data-dir file of a packaged app", () => {
  const dir = dataDir();
  expect(loadRelayConfig({ dataDir: dir, packaged: true, env: {} })).toEqual({ kind: "absent" });
  place(dir, SYNTHETIC);
  const loaded = loadRelayConfig({ dataDir: dir, packaged: true, env: {} });
  expect(loaded).toEqual({
    kind: "ready",
    relay: {
      projectId: "synthetic-project",
      target: "firebase",
      firestore: { projectId: "synthetic-project" },
      identity: { apiKey: SYNTHETIC.apiKey },
    },
  });
});

it("ignores every env override in a packaged app", () => {
  const dir = dataDir();
  const other = dataDir();
  const path = place(other, SYNTHETIC);
  const env = {
    CASHU_FIREBASE_CONFIG: path,
    CASHU_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    CASHU_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  };
  expect(loadRelayConfig({ dataDir: dir, packaged: true, env })).toEqual({ kind: "absent" });
  expect(
    loadRelayConfig({ dataDir: dir, packaged: false, env: { CASHU_FIREBASE_CONFIG: path } }),
  ).toMatchObject({ kind: "ready", relay: { projectId: "synthetic-project" } });
});

it("switches to the loopback emulators, with demo-cashu when no file is given", () => {
  const dir = dataDir();
  const env = {
    CASHU_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    CASHU_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  };
  expect(loadRelayConfig({ dataDir: dir, packaged: false, env })).toEqual({
    kind: "ready",
    relay: {
      projectId: "demo-cashu",
      target: "emulator",
      firestore: { projectId: "demo-cashu", baseUrl: "http://127.0.0.1:8080" },
      identity: {
        apiKey: "emulator-key",
        baseUrl: "http://127.0.0.1:9099/identitytoolkit.googleapis.com",
        tokenBaseUrl: "http://127.0.0.1:9099/securetoken.googleapis.com",
      },
    },
  });
  for (const bad of [
    { CASHU_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
    { ...env, CASHU_FIRESTORE_EMULATOR_HOST: "relay.example.test:8080" },
  ])
    expect(loadRelayConfig({ dataDir: dir, packaged: false, env: bad })).toEqual({
      kind: "invalid",
      code: "relay_emulator_host_invalid",
    });
});

it("refuses a malformed, oversized or relative config with a value-free code", () => {
  const dir = dataDir();
  const secretLooking = "AIzaShouldNeverAppearInAnError000000000000";
  place(dir, { ...SYNTHETIC, apiKey: `${secretLooking}/../x` });
  const malformed = loadRelayConfig({ dataDir: dir, packaged: true, env: {} });
  expect(malformed).toEqual({ kind: "invalid", code: "relay_config_malformed" });
  expect(JSON.stringify(malformed)).not.toContain(secretLooking);
  place(dir, "{ not json");
  expect(loadRelayConfig({ dataDir: dir, packaged: true, env: {} })).toEqual({
    kind: "invalid",
    code: "relay_config_malformed",
  });
  place(dir, " ".repeat(17 * 1024));
  expect(loadRelayConfig({ dataDir: dir, packaged: true, env: {} })).toEqual({
    kind: "invalid",
    code: "relay_config_too_large",
  });
  expect(
    loadRelayConfig({
      dataDir: dir,
      packaged: false,
      env: { CASHU_FIREBASE_CONFIG: "relay/firebase.json" },
    }),
  ).toEqual({ kind: "invalid", code: "relay_config_path_invalid" });
});
