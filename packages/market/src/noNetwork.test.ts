// Guard: no market test performs a real network request. Two layers:
// 1. runtime: the vitest setup file of this package makes fetch, sockets, http(s) and DNS throw, and
//    this file proves each one throws inside a test;
// 2. static: no test or test helper of the market code (this package and the pure domain part)
//    reaches a network API itself; they pass a fake `fetch` to the sources.

import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { NETWORK_BLOCKED } from "./testing/noNetwork.setup.js";

const PACKAGE = new URL("../", import.meta.url);
const ROOTS = [new URL("src/", PACKAGE), new URL("../domain/src/investments/market/", PACKAGE)];

function files(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(new URL(`${entry.name}/`, dir))
      : /\.tsx?$/.test(entry.name)
        ? [new URL(entry.name, dir)]
        : [],
  );
}

const isTestCode = (url: URL) =>
  /\.test\.tsx?$/.test(url.pathname) || url.pathname.includes("/testing/");

describe("guard: the network is blocked in every market test", () => {
  it("the global fetch throws", () => {
    expect(() => fetch("https://example.com/")).toThrow(NETWORK_BLOCKED);
  });

  it("sockets, TLS, http and https throw before connecting", () => {
    expect(() => net.connect(443, "example.com")).toThrow(NETWORK_BLOCKED);
    expect(() => new net.Socket().connect(443, "example.com")).toThrow(NETWORK_BLOCKED);
    expect(() => tls.connect(443, "example.com")).toThrow(NETWORK_BLOCKED);
    expect(() => http.get("http://example.com/")).toThrow(NETWORK_BLOCKED);
    expect(() => https.request("https://example.com/")).toThrow(NETWORK_BLOCKED);
  });

  it("the setup file is wired into this package's vitest config", () => {
    const config = readFileSync(new URL("vitest.config.ts", PACKAGE), "utf8");
    expect(config).toContain("./src/testing/noNetwork.setup.ts");
  });
});

describe("guard: market tests only use a fake fetch", () => {
  const NETWORK_API =
    /(?<![.\w]|async\s)fetch\s*\(|(globalThis|window|self)\.fetch\b|from\s+["'](node:)?(http|https|net|tls|dns|http2|dgram)["']|from\s+["'](undici|ws|axios|node-fetch)["']|new\s+(WebSocket|XMLHttpRequest)\b/;
  const testFiles = ROOTS.flatMap(files).filter(isTestCode);

  it("finds the market tests", () => {
    expect(testFiles.length).toBeGreaterThan(5);
  });

  it.each(
    testFiles
      .filter(
        (f) =>
          !f.pathname.endsWith("/noNetwork.test.ts") && !f.pathname.endsWith("/noNetwork.setup.ts"),
      )
      .map((f) => [f.pathname.split("/packages/")[1], f] as const),
  )("%s reaches no network API", (_name, file) => {
    const source = readFileSync(file, "utf8");
    expect(
      source.match(NETWORK_API)?.[0] ?? null,
      "pass a fake fetch (testing/support.ts) instead",
    ).toBeNull();
  });
});
