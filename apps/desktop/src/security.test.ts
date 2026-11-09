import { describe, expect, it } from "vitest";
import {
  ALLOW,
  BLOCK,
  bridgeAllowed,
  EXTERNAL,
  navigationDecision,
  permissionAllowed,
  sameOrigin,
  sanitizeLogLine,
} from "./security.js";

const ORIGIN = "app://cashu/index.html";
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123";

describe("origin matching", () => {
  it("accepts only the native app origin", () => {
    expect(sameOrigin("app://cashu/assets/x?y=1", ORIGIN)).toBe(true);
    expect(sameOrigin("app://other/index.html", ORIGIN)).toBe(false);
    expect(sameOrigin("http://127.0.0.1:8500/", ORIGIN)).toBe(false);
  });
});

describe("web permissions", () => {
  it("grants only the clipboard write, and only to the app origin", () => {
    expect(permissionAllowed("clipboard-sanitized-write", "app://cashu", ORIGIN)).toBe(true);
    expect(permissionAllowed("clipboard-sanitized-write", `${ORIGIN}#/setup`, ORIGIN)).toBe(true);
    expect(permissionAllowed("clipboard-read", "app://cashu", ORIGIN)).toBe(false);
    expect(permissionAllowed("media", "app://cashu", ORIGIN)).toBe(false);
    expect(permissionAllowed("notifications", "app://cashu", ORIGIN)).toBe(false);
    expect(permissionAllowed("clipboard-sanitized-write", "https://evil.example/", ORIGIN)).toBe(
      false,
    );
    expect(permissionAllowed("clipboard-sanitized-write", "", ORIGIN)).toBe(false);
    expect(permissionAllowed("clipboard-sanitized-write", "app://cashu", null)).toBe(false);
  });
});

describe("navigation is pinned to the app origin (PK5)", () => {
  it("loads the app, its blob: downloads and about: pages in the window", () => {
    expect(navigationDecision(`${ORIGIN}/#/x`, ORIGIN)).toBe(ALLOW);
    expect(navigationDecision("about:blank", ORIGIN)).toBe(ALLOW);
    expect(navigationDecision(`blob:${ORIGIN}/0c3e`, ORIGIN)).toBe(ALLOW);
    expect(navigationDecision("blob:https://evil.example/0c3e", ORIGIN)).toBe(BLOCK);
  });

  it("opens other http(s) links in the browser and drops every other scheme", () => {
    expect(navigationDecision("https://example.com/a", ORIGIN)).toBe(EXTERNAL);
    expect(navigationDecision("http://127.0.0.1:9/", ORIGIN)).toBe(EXTERNAL);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "cashu://open", "", "x"]) {
      expect(navigationDecision(url, ORIGIN)).toBe(BLOCK);
    }
  });
});

describe("desktop log sanitization", () => {
  it("strips terminal escapes and accidental credential fragments", () => {
    expect(sanitizeLogLine(`app://cashu/#token=${TOKEN} done`)).toBe(
      "app://cashu/#token=<redacted> done",
    );
    expect(sanitizeLogLine("\u001b[32mstarted\u001b[0m")).toBe("started");
  });
});

describe("native bridge is exposed to the app origin only", () => {
  it("allows the app's own page and nothing else", () => {
    expect(bridgeAllowed(`${ORIGIN}/#/demo-anna/overview`, ORIGIN)).toBe(true);
    for (const url of [
      "data:text/html,loading",
      "about:blank",
      "https://evil.example/",
      "http://127.0.0.1:8501/",
      "http://localhost:8500/",
      "",
      null,
      undefined,
    ]) {
      expect(bridgeAllowed(url, ORIGIN)).toBe(false);
    }
    // A missing app origin never exposes a bridge.
    expect(bridgeAllowed(`${ORIGIN}/`, null)).toBe(false);
  });
});
