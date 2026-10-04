// Dev-only guard for the Vite proxy (see vite.config.ts), kept in its own file so
// `npm test` can check it without starting Vite.
//
// The backend's CSRF defence is "a cross-site page cannot add X-Finanse-Token".
// The dev proxy adds that header itself, so it must only do so for requests
// that come from the dev page itself: anything a browser marks as cross-site
// (Origin, Referer or Sec-Fetch-Site) is refused before it reaches the backend.

type Headers = Record<string, string | string[] | undefined>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const first = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** True when the proxied request may carry the API token: it is addressed to a
 * loopback dev host and nothing in it says it comes from another site. Requests
 * without any browser context (address bar, curl) are allowed. */
export function proxyAllowed(headers: Headers): boolean {
  const host = first(headers.host)?.toLowerCase();
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (!LOOPBACK.has(hostname)) return false;
  const self = `http://${host}`;

  const site = first(headers["sec-fetch-site"])?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = first(headers.origin);
  if (origin && origin.toLowerCase() !== self) return false;
  const referer = first(headers.referer);
  if (referer && originOf(referer)?.toLowerCase() !== self) return false;
  return true;
}
