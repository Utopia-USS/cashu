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

export interface Dashboard {
  port: number;
  token: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Terminal colour codes removed (rich colours its output when FORCE_COLOR or a TTY says so). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const DASHBOARD_LINE = /Dashboard:http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]{20,})/;

/**
 * The one-time `Dashboard: http://127.0.0.1:<port>/#token=<token>` line `cashu serve` prints
 * (the only way to learn the sidecar's per-launch token). Whitespace is dropped first because
 * the console may wrap a long line.
 */
export function parseDashboardLine(output: string): Dashboard | null {
  const match = DASHBOARD_LINE.exec(stripAnsi(output).replace(/\s+/g, ""));
  if (!match?.[1] || !match[2]) return null;
  return { port: Number(match[1]), token: match[2] };
}

/** Any `#token=...` in text that may reach a log is blanked (the token is never persisted). */
export function redactToken(text: string): string {
  return stripAnsi(text).replace(/(#token=)[A-Za-z0-9_-]+/g, "$1<redacted>");
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
