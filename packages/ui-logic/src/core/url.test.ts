import { describe, expect, it } from "vitest";
import { hostOf } from "./url.js";

describe("hostOf", () => {
  it("gives the lowercased host without www, user info and port, as URL.hostname does", () => {
    expect(hostOf("https://www.bankier.pl/forum")).toBe("bankier.pl");
    expect(hostOf("HTTPS://WWW.Foo.pl")).toBe("foo.pl");
    expect(hostOf("http://user:pw@Host.COM:8080/x?y#z")).toBe("host.com");
    expect(hostOf(" https://x.y/ ")).toBe("x.y");
    expect(hostOf("https://a.b?q")).toBe("a.b");
    expect(hostOf("https://[::1]:80/")).toBe("[::1]");
  });

  it("is null without an absolute URL", () => {
    for (const u of ["not a url", "", null, undefined, "/relative/path", "mailto:x@y.z"])
      expect(hostOf(u)).toBeNull();
  });
});
