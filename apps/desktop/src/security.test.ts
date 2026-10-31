import { describe, expect, it } from "vitest";
import {
  ALLOW,
  BLOCK,
  bridgeAllowed,
  EXTERNAL,
  generateToken,
  navigationDecision,
  redactToken,
  sameOrigin,
  tokenForSender,
} from "./security.js";

const ORIGIN = "http://127.0.0.1:8500";
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123";

describe("token bridge (shell.token_bridge)", () => {
  it("answers only the app's own page", () => {
    expect(tokenForSender(`${ORIGIN}/#/demo-anna/overview`, ORIGIN, TOKEN)).toBe(TOKEN);
    expect(tokenForSender("https://evil.example/", ORIGIN, TOKEN)).toBeNull();
    expect(tokenForSender("http://127.0.0.1:8501/", ORIGIN, TOKEN)).toBeNull();
    expect(tokenForSender("http://localhost:8500/", ORIGIN, TOKEN)).toBeNull();
    expect(tokenForSender("http://127.0.0.1.evil.example:8500/", ORIGIN, TOKEN)).toBeNull();
    expect(tokenForSender("data:text/html,<p>x</p>", ORIGIN, TOKEN)).toBeNull();
    expect(tokenForSender("", ORIGIN, TOKEN)).toBeNull();
    expect(tokenForSender(null, ORIGIN, TOKEN)).toBeNull();
    expect(tokenForSender("not a url", ORIGIN, TOKEN)).toBeNull();
  });

  it("compares scheme, host and port exactly", () => {
    expect(sameOrigin("http://127.0.0.1:8500/x?y=1", ORIGIN)).toBe(true);
    expect(sameOrigin("https://127.0.0.1:8500/", ORIGIN)).toBe(false);
    expect(sameOrigin("http://127.0.0.1/", ORIGIN)).toBe(false);
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

describe("the per-launch token", () => {
  it("is 32 random bytes in URL-safe base64, the shape core/parent_pipe.py accepts", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
    expect(generateToken(() => Buffer.alloc(32, 0xff))).toBe(`${"_".repeat(42)}8`);
  });

  it("is redacted before anything is logged", () => {
    expect(redactToken(`Dashboard: http://127.0.0.1:8500/#token=${TOKEN} done`)).toBe(
      "Dashboard: http://127.0.0.1:8500/#token=<redacted> done",
    );
    expect(redactToken(`\u001b[32mgot ${TOKEN}\u001b[0m`, TOKEN)).toBe("got <redacted>");
  });
});

describe("the pywebview shim is exposed to the app origin only", () => {
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
    // before the sidecar answered there is no app origin: nothing is exposed
    expect(bridgeAllowed(`${ORIGIN}/`, null)).toBe(false);
  });
});
