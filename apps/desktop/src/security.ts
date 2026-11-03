/// <reference types="node" />
import { randomBytes } from "node:crypto";

/** Port of the window-side policy of desktop/shell.py: same-origin check, navigation decision
 * (PK5) and the token bridge answer (PK1). The server side (Host allowlist, token header) stays in
 * the Python sidecar for v1 (core/security.py). */

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

function portOf(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

/** `url` is on `origin` (`http://127.0.0.1:<port>`): exact scheme, host and port. */
export function sameOrigin(url: string, origin: string): boolean {
  const a = parse(url);
  const b = parse(origin);
  if (!a || !b) return false;
  if (b.protocol === "app:") {
    return (
      a.protocol === "app:" &&
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
  return a.protocol === b.protocol && a.hostname === b.hostname && portOf(a) === portOf(b);
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

/** Terminal colour codes removed before a sidecar line reaches the log. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The per-launch API token: 32 random bytes, URL-safe base64 (core/security.py `generate_token`). */
export function generateToken(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

/**
 * Text that may reach a log, with the token blanked: any `#token=...` URL and, when given, the
 * token value itself (the sidecar never prints it; this is the second line of defence).
 */
export function redactToken(text: string, token?: string | null): string {
  let clean = stripAnsi(text).replace(/(#token=)[A-Za-z0-9_-]+/g, "$1<redacted>");
  if (token) clean = clean.replaceAll(token, "<redacted>");
  return clean;
}

/**
 * TRANSITIONAL(S55z): the preload exposes the `window.pywebview` shim only to a page on the app's
 * own origin (the legacy SPA needs it until S55z retires the SPA from the window). The main process
 * decides from the sending frame's URL, never from what the page claims.
 */
export function bridgeAllowed(
  senderUrl: string | null | undefined,
  origin: string | null,
): boolean {
  return Boolean(senderUrl && origin && sameOrigin(senderUrl, origin));
}

/**
 * `window.pywebview.api.token()`: answered only while the sending page shows the app's own
 * origin, so a foreign page (which the navigation policy keeps out anyway) never gets the token.
 */
export function tokenForSender(
  senderUrl: string | null | undefined,
  origin: string,
  token: string,
): string | null {
  return senderUrl && sameOrigin(senderUrl, origin) ? token : null;
}
