// The Sparkle feed (appcast) that tells the retired Python cashU.app about the native app.
//
// The Python app (bundle io.utopiasoft.cashu, last release 0.4.6, Sparkle 2.10.0) checks
// https://github.com/Utopia-USS/cashu/releases/latest/download/appcast-macos-<uname -m>.xml once a day and
// on "Sprawdź aktualizacje…". Every native release uploads that file with ONE informational item: the old
// app learns that a new version exists and installs nothing (Sparkle never downloads an informational
// item; a reply "install" to one is turned into "dismiss", SPUUIBasedUpdateDriver.m).
//
// What Sparkle 2.10.0 does with the item (from its source, SUAppcast.m / SUAppcastItem.m):
// - an item with a <link> (http or https) and no <enclosure> is informational for every app version;
//   <sparkle:informationalUpdate> with <sparkle:belowVersion> says the same thing explicitly and is kept
//   for any reader that requires it;
// - <sparkle:version> is compared with the app's CFBundleVersion (the Python builds publish "0.4.6"), so the
//   native version must compare above it (the guard below);
// - duplicate elements with xml:lang (here <title> and <description>) are chosen by the user's languages;
// - <sparkle:minimumSystemVersion>: a Mac below it is not offered the item (the native app needs macOS 13);
// - the feed needs no signature: the Python Info.plist has no SURequireSignedFeed.
//
// The Python app (0.4.2 and 0.4.6 alike) shows the offer in its own dashboard card (desktop/updater.py
// CashuUserDriver): "New version <sparkle:shortVersionString>" / "Nowa wersja ...", with "Update" (which
// Sparkle turns into a dismiss) and "Skip". It never shows <link> or <description>. So by default
// <sparkle:shortVersionString> carries a pointer as well, "0.5.0 - github.com/Utopia-USS/cashu/releases":
// Sparkle only displays it, while <sparkle:version> stays the plain version that Sparkle compares and
// records when the owner chooses "Skip". `pointer: false` writes the plain version. <link> and <description> still matter for any Sparkle standard UI.
//
//   import { appcastFileName, informationalAppcast } from "./release/appcast.mjs";
//   writeFileSync(appcastFileName("arm64"), informationalAppcast({ arch: "arm64", version, ... }));
//
// Node built-ins only.

const SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle";

/** The last Python release: every native version must compare above it. */
export const LAST_PYTHON_VERSION = "0.4.6";

/** The native app's minimum macOS (Electron 45 and the native addons are built for macOS 13.0). */
export const NATIVE_MIN_MACOS = "13.0";

/** Native arch name -> the `uname -m` name the Python app puts into its feed URL (scripts/build_macos.sh). */
const PYTHON_FEED_ARCH = { arm64: "arm64", x64: "x86_64" };

const ARCH_LABEL = { arm64: "Apple Silicon", x64: "Intel" };

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The file name the Python app of this architecture fetches from the latest release:
 * `appcast-macos-arm64.xml` or `appcast-macos-x86_64.xml` (not `x64`: the old app builds the name from
 * `uname -m`).
 */
export function appcastFileName(arch) {
  return `appcast-macos-${PYTHON_FEED_ARCH[checkArch(arch)]}.xml`;
}

/**
 * The informational Sparkle feed for one architecture: RSS 2.0 with the Sparkle namespace and one item.
 *
 * @param {object} release
 * @param {"arm64" | "x64"} release.arch
 * @param {string} release.version the native version, X.Y.Z above 0.4.6
 * @param {string} release.releasePageUrl the GitHub release page (the item's <link>)
 * @param {string} release.downloadUrl this architecture's dmg
 * @param {Date | string} release.pubDate
 * @param {boolean} [release.pointer] the shown version carries where to download (default true)
 * @returns {string}
 */
export function informationalAppcast({
  arch,
  version,
  releasePageUrl,
  downloadUrl,
  pubDate,
  pointer = true,
}) {
  checkArch(arch);
  checkVersion(version);
  const page = checkUrl("releasePageUrl", releasePageUrl);
  const dmg = checkUrl("downloadUrl", downloadUrl);
  const date = rfc822(pubDate);
  const label = ARCH_LABEL[arch];
  const shown = pointer ? `${version} - ${releasesPointer(page)}` : version;

  const notes = {
    pl: [
      `Dostępna jest nowa, natywna aplikacja cashU ${version} (${label}).`,
      `Pobierz ją: ${dmg}`,
      `Strona wydania: ${page}`,
      "Przy pierwszym uruchomieniu kliknij „Zaimportuj moje dane”, a cashU przeniesie Twoje dane.",
      "Ta aplikacja nie będzie się już sama aktualizować.",
    ],
    en: [
      `A new, native cashU app ${version} (${label}) is available.`,
      `Download it: ${dmg}`,
      `Release page: ${page}`,
      'On its first start, click "Import my data" and cashU brings your data over.',
      "This app will not update itself any more.",
    ],
  };
  const titles = { pl: `Nowa aplikacja cashU ${version}`, en: `New cashU app ${version}` };

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<rss version="2.0" xmlns:sparkle="${SPARKLE_NS}">`,
    "  <channel>",
    "    <title>cashU</title>",
    `    <link>${xml(page)}</link>`,
    "    <description>cashU updates</description>",
    "    <item>",
    ...["pl", "en"].map((lang) => `      <title xml:lang="${lang}">${xml(titles[lang])}</title>`),
    `      <pubDate>${date}</pubDate>`,
    `      <link>${xml(page)}</link>`,
    `      <sparkle:version>${version}</sparkle:version>`,
    `      <sparkle:shortVersionString>${xml(shown)}</sparkle:shortVersionString>`,
    `      <sparkle:minimumSystemVersion>${NATIVE_MIN_MACOS}</sparkle:minimumSystemVersion>`,
    "      <sparkle:informationalUpdate>",
    `        <sparkle:belowVersion>${version}</sparkle:belowVersion>`,
    "      </sparkle:informationalUpdate>",
    ...["pl", "en"].map(
      (lang) =>
        `      <description xml:lang="${lang}" sparkle:format="plain-text">${xml(notes[lang].join("\n"))}</description>`,
    ),
    "    </item>",
    "  </channel>",
    "</rss>",
    "",
  ];
  return lines.join("\n");
}

function checkArch(arch) {
  if (!Object.hasOwn(PYTHON_FEED_ARCH, arch)) {
    throw new Error(`appcast: unknown arch ${JSON.stringify(arch)} (arm64 or x64)`);
  }
  return arch;
}

function checkVersion(version) {
  const m = typeof version === "string" ? VERSION_RE.exec(version) : null;
  if (!m) throw new Error(`appcast: version ${JSON.stringify(version)} is not X.Y.Z`);
  if (compareVersions(version, LAST_PYTHON_VERSION) <= 0) {
    throw new Error(
      `appcast: version ${version} must be above the last Python release ${LAST_PYTHON_VERSION}, ` +
        "or the old apps never see it",
    );
  }
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function checkUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`appcast: ${name} ${JSON.stringify(value)} is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`appcast: ${name} must be an https URL`);
  return url.href;
}

/** "https://github.com/Utopia-USS/cashu/releases/tag/v0.5.0" -> "github.com/Utopia-USS/cashu/releases". */
function releasesPointer(page) {
  const url = new URL(page);
  const path = url.pathname.replace(/\/+$/, "");
  const at = path.indexOf("/releases");
  return `${url.host}${at >= 0 ? path.slice(0, at + "/releases".length) : path}`;
}

function rfc822(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (value == null || Number.isNaN(date.getTime())) {
    throw new Error(`appcast: pubDate ${JSON.stringify(value)} is not a date`);
  }
  // "Sat, 07 Nov 2026 16:00:00 GMT": the RFC 822 / 1123 form RSS 2.0 asks for.
  return date.toUTCString();
}

function xml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
