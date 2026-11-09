/// <reference types="node" />

/** Window-side same-origin and navigation policy. */

export const ALLOW = "allow";
export const EXTERNAL = "external";
export const BLOCK = "block";
export type NavigationDecision = typeof ALLOW | typeof EXTERNAL | typeof BLOCK;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Both URLs belong to the fixed native app origin. */
export function sameOrigin(url: string, origin: string): boolean {
  const a = parse(url);
  const b = parse(origin);
  if (!a || !b) return false;
  return (
    a.protocol === "app:" &&
    b.protocol === "app:" &&
    a.hostname === "cashu" &&
    b.hostname === "cashu" &&
    !a.username &&
    !a.password &&
    !a.port &&
    !b.username &&
    !b.password &&
    !b.port
  );
}

/**
 * Where a navigation of the window goes: the app's own origin (and its blob: URLs, the CSV export)
 * and about: pages load in the window; other http(s) URLs open in the default browser; every
 * other scheme (file:, javascript:, custom app schemes) is dropped.
 */
export function navigationDecision(url: string, origin: string): NavigationDecision {
  if (url.startsWith("about:")) return ALLOW;
  if (url.startsWith("blob:")) return sameOrigin(url.slice("blob:".length), origin) ? ALLOW : BLOCK;
  if (sameOrigin(url, origin)) return ALLOW;
  const scheme = parse(url)?.protocol.replace(/:$/, "").toLowerCase() ?? "";
  return scheme === "http" || scheme === "https" ? EXTERNAL : BLOCK;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Terminal colour codes removed before a line reaches the desktop log. */
function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Keep accidental fragment credentials out of desktop logs. */
export function sanitizeLogLine(text: string): string {
  return stripAnsi(text).replace(/(#token=)[A-Za-z0-9_-]+/g, "$1<redacted>");
}

/** The one web permission the app grants: writing plain text to the clipboard (`navigator.clipboard`). */
const CLIPBOARD_WRITE = "clipboard-sanitized-write";

/**
 * Whether a page may use a web permission (session permission request and check handlers): only the
 * clipboard write behind the copy buttons, and only from the app's own origin. Every other permission
 * (camera, notifications, clipboard read, ...) stays denied.
 */
export function permissionAllowed(
  permission: string,
  requestingUrl: string | null | undefined,
  origin: string | null,
): boolean {
  return (
    permission === CLIPBOARD_WRITE &&
    Boolean(requestingUrl && origin && sameOrigin(requestingUrl, origin))
  );
}

/**
 * The preload exposes native bridges only to the app's own origin. The main process decides
 * from the sending frame's URL, never from what the page claims.
 */
export function bridgeAllowed(
  senderUrl: string | null | undefined,
  origin: string | null,
): boolean {
  return Boolean(senderUrl && origin && sameOrigin(senderUrl, origin));
}
