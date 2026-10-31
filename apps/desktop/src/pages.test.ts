import { describe, expect, it } from "vitest";
import { dataUrl, errorHtml, loadingHtml } from "./pages.js";
import { pickLang, STRINGS } from "./strings.js";

describe("boot pages", () => {
  it("escapes the error message and the log path", () => {
    const html = errorHtml("en", '<script>alert("x")</script> & more', "/tmp/<log>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; more");
    expect(html).toContain("/tmp/&lt;log&gt;");
    expect(html).toContain('lang="en"');
  });

  it("shows the loading text in both languages", () => {
    expect(loadingHtml("pl")).toContain("Uruchamianie cashU");
    expect(loadingHtml("en")).toContain("Starting cashU");
  });

  it("builds a data URL that round-trips", () => {
    const html = loadingHtml("en");
    const url = dataUrl(html);
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(html);
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

  it("has both languages for every text", () => {
    for (const entry of Object.values(STRINGS)) {
      expect(entry.pl.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
    }
  });
});
