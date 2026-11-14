// Which relay a build talks to, from its EXPO_PUBLIC_* variables: the plain variables, the JSON
// fallback, and the emulator hosts honoured only by a dev build. Synthetic values only.
import { resolveRelayConfig } from "./relayConfig";

const PLAIN = {
  projectId: "synthetic-project",
  apiKey: "synthetic-api-key",
  appId: "1:000000000000:ios:0000000000000000",
  authDomain: "synthetic-project.example.test",
};
const EMULATOR = { firestoreEmulatorHost: "127.0.0.1:8080", authEmulatorHost: "127.0.0.1:9099" };

const FIREBASE_SYNTHETIC = {
  projectId: "synthetic-project",
  target: "firebase",
  firestore: { projectId: "synthetic-project" },
  identity: { apiKey: "synthetic-api-key" },
};

describe("resolveRelayConfig", () => {
  it("reads the four plain variables as the production endpoints", () => {
    expect(resolveRelayConfig(PLAIN, false)).toEqual(FIREBASE_SYNTHETIC);
  });

  it("keeps the JSON form when it parses, and ignores it when it arrives truncated", () => {
    expect(resolveRelayConfig({ json: JSON.stringify(PLAIN) }, false)).toEqual(FIREBASE_SYNTHETIC);
    // What a double-quoted JSON value with escaped quotes becomes after Expo's .env parsing.
    expect(resolveRelayConfig({ json: "{\\" }, false)).toBeUndefined();
    expect(resolveRelayConfig({ ...PLAIN, json: "{\\" }, false)).toEqual(FIREBASE_SYNTHETIC);
  });

  it("reads an incomplete plain set as no relay", () => {
    expect(resolveRelayConfig({ ...PLAIN, appId: undefined }, false)).toBeUndefined();
    expect(resolveRelayConfig({}, true)).toBeUndefined();
  });

  it("points a dev build at the emulators, as demo-cashu without project variables", () => {
    expect(resolveRelayConfig(EMULATOR, true)).toEqual({
      projectId: "demo-cashu",
      target: "emulator",
      firestore: { projectId: "demo-cashu", baseUrl: "http://127.0.0.1:8080" },
      identity: {
        apiKey: "emulator-key",
        baseUrl: "http://127.0.0.1:9099/identitytoolkit.googleapis.com",
        tokenBaseUrl: "http://127.0.0.1:9099/securetoken.googleapis.com",
      },
    });
    const withProject = resolveRelayConfig({ ...PLAIN, ...EMULATOR }, true);
    expect(withProject?.target).toBe("emulator");
    expect(withProject?.firestore).toEqual({
      projectId: "synthetic-project",
      baseUrl: "http://127.0.0.1:8080",
    });
  });

  it("makes a release build ignore the emulator hosts", () => {
    expect(resolveRelayConfig(EMULATOR, false)).toBeUndefined();
    expect(resolveRelayConfig({ ...PLAIN, ...EMULATOR }, false)).toEqual(FIREBASE_SYNTHETIC);
  });

  it.each([
    ["only the Firestore host", { firestoreEmulatorHost: "127.0.0.1:8080" }],
    ["only the auth host", { authEmulatorHost: "127.0.0.1:9099" }],
    ["a host that is not loopback", { ...EMULATOR, firestoreEmulatorHost: "192.0.2.1:8080" }],
  ])("turns the relay off for %s in a dev build (no fallback to the project)", (_case, hosts) => {
    expect(resolveRelayConfig({ ...PLAIN, ...hosts }, true)).toBeUndefined();
  });
});
