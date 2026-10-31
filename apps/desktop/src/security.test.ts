import { describe, expect, it } from "vitest";
import {
  ALLOW,
  BLOCK,
  EXTERNAL,
  navigationDecision,
  parseDashboardLine,
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

describe("the one-time Dashboard line", () => {
  it("is parsed from the sidecar output, also when the console wrapped it", () => {
    const line = `Dashboard: http://127.0.0.1:8500/#token=${TOKEN}`;
    expect(parseDashboardLine(`noise\n${line}\n`)).toEqual({ port: 8500, token: TOKEN });
    expect(parseDashboardLine(`Dashboard: http://127.0.0.1:8500/#token=\n${TOKEN}`)).toEqual({
      port: 8500,
      token: TOKEN,
    });
    expect(parseDashboardLine(`Dashboard: http://example.com:8500/#token=${TOKEN}`)).toBeNull();
    expect(parseDashboardLine("nothing here")).toBeNull();
  });

  it("is parsed and redacted through terminal colour codes", () => {
    const coloured = `\u001b[32mDashboard:\u001b[0m \u001b[4;94mhttp://127.0.0.1:8500/#\u001b[0m\u001b[4;94mtoken\u001b[0m\u001b[4;94m=\u001b[0m\u001b[4;94m${TOKEN}\u001b[0m`;
    expect(parseDashboardLine(coloured)).toEqual({ port: 8500, token: TOKEN });
    expect(redactToken(coloured)).not.toContain(TOKEN);
  });

  it("is redacted before anything is logged", () => {
    expect(redactToken(`Dashboard: http://127.0.0.1:8500/#token=${TOKEN} done`)).toBe(
      "Dashboard: http://127.0.0.1:8500/#token=<redacted> done",
    );
  });
});
