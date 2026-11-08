import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  appcastFileName,
  informationalAppcast,
  LAST_PYTHON_VERSION,
  NATIVE_MIN_MACOS,
} from "./appcast.mjs";

const SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle";
const RELEASE = "https://github.com/Utopia-USS/cashu/releases/tag/v0.5.0";
const dmg = (arch) =>
  `https://github.com/Utopia-USS/cashu/releases/download/v0.5.0/cashU-0.5.0-mac-${arch}.dmg`;

function feed(overrides = {}) {
  return informationalAppcast({
    arch: "arm64",
    version: "0.5.0",
    releasePageUrl: RELEASE,
    downloadUrl: dmg("arm64"),
    pubDate: new Date(Date.UTC(2026, 10, 7, 16, 0, 0)),
    ...overrides,
  });
}

/** Parses strictly as XML (jsdom throws on a malformed document). */
function parse(text) {
  const doc = new JSDOM(text, { contentType: "application/xml" }).window.document;
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  return doc;
}

function item(doc) {
  const items = doc.getElementsByTagName("item");
  expect(items).toHaveLength(1);
  return items[0];
}

const sparkle = (el, name) => [...el.getElementsByTagNameNS(SPARKLE_NS, name)];
const children = (el, name) => [...el.children].filter((c) => c.tagName === name);

describe("informationalAppcast", () => {
  it("writes well-formed RSS 2.0 with the Sparkle namespace and one informational item", () => {
    const doc = parse(feed());
    const rss = doc.documentElement;
    expect(rss.tagName).toBe("rss");
    expect(rss.getAttribute("version")).toBe("2.0");
    expect(rss.lookupNamespaceURI("sparkle")).toBe(SPARKLE_NS);

    const it = item(doc);
    expect(children(it, "link").map((l) => l.textContent)).toEqual([RELEASE]);
    expect(sparkle(it, "version").map((v) => v.textContent)).toEqual(["0.5.0"]);
    expect(sparkle(it, "shortVersionString").map((v) => v.textContent)).toEqual([
      "0.5.0 - github.com/Utopia-USS/cashu/releases",
    ]);
    expect(sparkle(it, "minimumSystemVersion").map((v) => v.textContent)).toEqual([
      NATIVE_MIN_MACOS,
    ]);
    const info = sparkle(it, "informationalUpdate");
    expect(info).toHaveLength(1);
    expect(sparkle(info[0], "belowVersion").map((v) => v.textContent)).toEqual(["0.5.0"]);
    // Informational: nothing for Sparkle to download, ever.
    expect(it.getElementsByTagName("enclosure")).toHaveLength(0);
    expect(children(it, "pubDate").map((d) => d.textContent)).toEqual([
      "Sat, 07 Nov 2026 16:00:00 GMT",
    ]);
  });

  it("points the old card at the releases page unless pointer is false, keeping the compared version plain", () => {
    const shown = (text) => sparkle(item(parse(text)), "shortVersionString")[0].textContent;
    const compared = (text) => sparkle(item(parse(text)), "version")[0].textContent;
    const pointed = shown(feed());
    // Read after "New version " / "Nowa wersja ": short, ASCII only (no em dash), no language.
    expect(pointed).toBe("0.5.0 - github.com/Utopia-USS/cashu/releases");
    expect(pointed).toMatch(/^[\x20-\x7e]+$/);
    expect(pointed.length).toBeLessThanOrEqual(48);
    expect(compared(feed())).toBe("0.5.0");
    expect(shown(feed({ pointer: true }))).toBe(pointed);
    expect(shown(feed({ pointer: false }))).toBe("0.5.0");
    expect(compared(feed({ pointer: false }))).toBe("0.5.0");
    expect(shown(feed({ releasePageUrl: "https://example.com/downloads/" }))).toBe(
      "0.5.0 - example.com/downloads",
    );
  });

  it("carries Polish and English titles and notes, each with xml:lang", () => {
    const it = item(parse(feed()));
    for (const name of ["title", "description"]) {
      const langs = children(it, name).map((el) =>
        el.getAttributeNS("http://www.w3.org/XML/1998/namespace", "lang"),
      );
      expect(langs).toEqual(["pl", "en"]);
    }
    const [pl, en] = children(it, "description");
    expect(pl.getAttributeNS(SPARKLE_NS, "format")).toBe("plain-text");
    expect(pl.textContent).toContain("Kopiuj prompt dla agenta");
    expect(pl.textContent).toContain(dmg("arm64"));
    expect(pl.textContent).toContain("nie będzie się już sama aktualizować");
    expect(en.textContent).toContain("Copy prompt for agent");
    expect(en.textContent).toContain(dmg("arm64"));
    expect(en.textContent).toContain(RELEASE);
  });

  it("names the prompt button exactly as the native app does", () => {
    const strings = readFileSync(
      new URL("../../renderer/shell/Recovery.strings.ts", import.meta.url),
      "utf8",
    );
    expect(strings).toContain(
      'copy: { pl: "Kopiuj prompt dla agenta", en: "Copy prompt for agent" }',
    );
  });

  it("differs per architecture only in the download and its label", () => {
    const arm = feed();
    const intel = feed({ arch: "x64", downloadUrl: dmg("x64") });
    expect(item(parse(intel)).textContent).toContain(dmg("x64"));
    expect(intel).toContain("(Intel)");
    expect(arm).toContain("(Apple Silicon)");
    expect(intel).not.toContain(dmg("arm64"));
    const normalize = (text) =>
      text.replaceAll(/cashU-0\.5\.0-mac-(arm64|x64)\.dmg/g, "DMG").replaceAll(/\([^)]+\)/g, "()");
    expect(normalize(arm)).toBe(normalize(intel));
  });

  it("escapes every interpolated value", () => {
    const tricky = "https://example.com/r?a=1&b=<2>&c=\"3\"&d='4'";
    const text = feed({ releasePageUrl: tricky, downloadUrl: tricky });
    const it = item(parse(text));
    const href = new URL(tricky).href;
    expect(children(it, "link")[0].textContent).toBe(href);
    expect(children(it, "description")[1].textContent).toContain(href);
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("refuses versions the Python apps would not see as newer", () => {
    for (const version of [LAST_PYTHON_VERSION, "0.4.5", "0.3.9", "0.0.1"]) {
      expect(() => feed({ version })).toThrow(/above the last Python release/);
    }
    for (const version of ["0.4.7", "0.5.0", "0.10.0", "1.0.0"]) {
      expect(() => feed({ version })).not.toThrow();
    }
  });

  it("refuses malformed input", () => {
    for (const version of ["0.5", "v0.5.0", "0.5.0-beta.1", "05.0.0", "", undefined]) {
      expect(() => feed({ version })).toThrow(/X\.Y\.Z/);
    }
    expect(() => feed({ arch: "x86_64" })).toThrow(/unknown arch/);
    expect(() => feed({ arch: "universal" })).toThrow(/unknown arch/);
    expect(() => feed({ downloadUrl: "http://example.com/a.dmg" })).toThrow(/https/);
    expect(() => feed({ releasePageUrl: "not a url" })).toThrow(/not a URL/);
    expect(() => feed({ pubDate: "yesterday" })).toThrow(/not a date/);
    expect(() => feed({ pubDate: undefined })).toThrow(/not a date/);
  });
});

describe("appcastFileName", () => {
  it("uses the uname -m names the Python app fetches", () => {
    expect(appcastFileName("arm64")).toBe("appcast-macos-arm64.xml");
    expect(appcastFileName("x64")).toBe("appcast-macos-x86_64.xml");
    expect(() => appcastFileName("x86_64")).toThrow(/unknown arch/);
  });
});
