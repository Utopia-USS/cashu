import { describe, expect, it } from "vitest";
import { errorHtml } from "./pages.js";
import { pickLang } from "./strings.js";

describe("boot pages", () => {
  it("escapes the error message and the log path", () => {
    const html = errorHtml("en", '<script>alert("x")</script> & more', "/tmp/<log>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; more");
    expect(html).toContain("/tmp/&lt;log&gt;");
    expect(html).toContain('lang="en"');
  });
});

describe("language", () => {
  it("follows the OS, else English, and can be pinned", () => {
    expect(pickLang(undefined, "pl-PL")).toBe("pl");
    expect(pickLang(undefined, "de-DE")).toBe("en");
    expect(pickLang(undefined, undefined)).toBe("en");
    expect(pickLang("en", "pl-PL")).toBe("en");
    expect(pickLang("pl", "en-US")).toBe("pl");
    expect(pickLang("xx", "pl")).toBe("pl");
  });
});
