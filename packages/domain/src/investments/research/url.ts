/**
 * `validation.check_url`: is a research source URL acceptable (`http(s)`, a public host name, no
 * credentials, no IP address, no paywall-bypass service)? Ports the parts of Python's
 * `urllib.parse.urlsplit` (scheme, netloc, bracketed hosts, the NFKC netloc check, `hostname`,
 * `port`, `username` / `password`) and `ipaddress.ip_address` (strict IPv4, IPv6 with an embedded
 * IPv4 tail and a scope id) that decide the outcome, with CPython 3.14's rules.
 */

import { pyRegex } from "../../pyRegex.js";
import { isPySpace, pyStrip } from "../../text.js";

export const URL_MAX = 500;

/** Paywall / bot-protection bypass services: research never cites them (use the original source). */
export const BYPASS_HOSTS: readonly string[] = Object.freeze([
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.li",
  "archive.vn",
  "archive.md",
  "12ft.io",
  "1ft.io",
  "removepaywall.com",
  "removepaywalls.com",
  "smry.ai",
  "paywallreader.com",
  "bypasspaywalls.org",
  "freedium.cfd",
]);

/** `_CONTROL`, verbatim. */
export const CONTROL_PATTERN = String.raw`[\x00-\x08\x0b-\x1f\x7f]`;
export const CONTROL = pyRegex(CONTROL_PATTERN);

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;
const IPV_FUTURE = pyRegex(String.raw`\Av[a-fA-F0-9]+\..+\Z`);

class UrlValueError extends Error {}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** Python `str.partition(sep)`. */
function partition(text: string, sep: string): [string, boolean, string] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, false, ""] : [text.slice(0, i), true, text.slice(i + sep.length)];
}

/** Python `str.rpartition(sep)`. */
function rpartition(text: string, sep: string): [string, boolean, string] {
  const i = text.lastIndexOf(sep);
  return i < 0 ? ["", false, text] : [text.slice(0, i), true, text.slice(i + sep.length)];
}

/** Python `str.split(sep, maxsplit)`. */
function splitMax(text: string, sep: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (out.length < maxsplit) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

/** Python `str.strip(chars)`. */
function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start] as string)) start++;
  while (end > start && chars.includes(text[end - 1] as string)) end--;
  return text.slice(start, end);
}

// ------------------------------------------------------------------------------- ipaddress

const ASCII_DIGITS = /^[0-9]+$/;
const HEX = /^[0-9A-Fa-f]*$/;

/** `IPv4Address(text)` succeeds. */
function isIPv4(text: string): boolean {
  if (!text || text.includes("/")) return false;
  const octets = text.split(".");
  if (octets.length !== 4) return false;
  return octets.every(
    (o) =>
      o !== "" &&
      ASCII_DIGITS.test(o) &&
      o.length <= 3 &&
      !(o !== "0" && o[0] === "0") &&
      Number(o) <= 255,
  );
}

/** `IPv6Address(text)` succeeds. */
function isIPv6(text: string): boolean {
  if (text.includes("/")) return false;
  const [address, hasScope, scope] = partition(text, "%");
  if (hasScope && (!scope || scope.includes("%"))) return false;
  if (!address || Array.from(address).length > 45) return false;
  const parts = splitMax(address, ":", 9);
  if (parts.length < 3) return false;
  if ((parts[parts.length - 1] as string).includes(".")) {
    if (!isIPv4(parts.pop() as string)) return false;
    parts.push("0", "0");
  }
  if (parts.length > 9) return false;
  let skip: number | null = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) {
      if (skip !== null) return false;
      skip = i;
    }
  }
  let hi: number;
  let lo: number;
  if (skip !== null) {
    hi = skip;
    lo = parts.length - skip - 1;
    if (!parts[0]) {
      hi -= 1;
      if (hi) return false;
    }
    if (!parts[parts.length - 1]) {
      lo -= 1;
      if (lo) return false;
    }
    if (8 - (hi + lo) < 1) return false;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return false;
    hi = parts.length;
    lo = 0;
  }
  const used = [...parts.slice(0, hi), ...(lo ? parts.slice(-lo) : [])];
  return used.every((h) => h !== "" && HEX.test(h) && h.length <= 4);
}

/** `ipaddress.ip_address(text)` succeeds; true for IPv4. */
function ipKind(text: string): "v4" | "v6" | null {
  if (isIPv4(text)) return "v4";
  if (isIPv6(text)) return "v6";
  return null;
}

// ------------------------------------------------------------------------------- urlsplit

interface SplitUrl {
  readonly scheme: string;
  readonly netloc: string;
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith("v")) {
    if (!IPV_FUTURE.test(hostname)) throw new UrlValueError("IPvFuture address is invalid");
    return;
  }
  const kind = ipKind(hostname);
  if (kind === null) throw new UrlValueError("not an IP address");
  if (kind === "v4") throw new UrlValueError("An IPv4 address cannot be in brackets");
}

function checkBracketedNetloc(netloc: string): void {
  const hostAndPort = rpartition(netloc, "@")[2];
  const [before, open, bracketed] = partition(hostAndPort, "[");
  let hostname: string;
  if (open) {
    if (before) throw new UrlValueError("Invalid IPv6 URL");
    const [host, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new UrlValueError("Invalid IPv6 URL");
    hostname = host;
  } else {
    hostname = partition(hostAndPort, ":")[0];
  }
  checkBracketedHost(hostname);
}

function checkNetloc(netloc: string): void {
  if (!netloc || isAscii(netloc)) return;
  const n = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
  const normalized = n.normalize("NFKC");
  if (n === normalized) return;
  for (const c of "/?#@:") {
    if (normalized.includes(c)) throw new UrlValueError("invalid characters under NFKC");
  }
}

/** `urlsplit(url)` for a URL without whitespace or control characters (scheme and netloc only). */
function urlsplit(input: string): SplitUrl {
  let url = input;
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  let netloc = "";
  if (url.startsWith("//")) {
    let delim = url.length;
    for (const c of "/?#") {
      const at = url.indexOf(c, 2);
      if (at >= 0) delim = Math.min(delim, at);
    }
    netloc = url.slice(2, delim);
    const open = netloc.includes("[");
    const close = netloc.includes("]");
    if ((open && !close) || (close && !open)) throw new UrlValueError("Invalid IPv6 URL");
    if (open && close) checkBracketedNetloc(netloc);
  }
  checkNetloc(netloc);
  return { scheme, netloc };
}

function hostInfo(netloc: string): [string, string | null] {
  const hostinfo = rpartition(netloc, "@")[2];
  const [, open, bracketed] = partition(hostinfo, "[");
  let hostname: string;
  let port: string;
  if (open) {
    const [host, , rest] = partition(bracketed, "]");
    hostname = host;
    port = partition(rest, ":")[2];
  } else {
    const [host, , rest] = partition(hostinfo, ":");
    hostname = host;
    port = rest;
  }
  return [hostname, port || null];
}

/** `SplitResult.hostname`: lower case except an IPv6 zone; null when empty. */
function hostnameOf(netloc: string): string | null {
  const hostname = hostInfo(netloc)[0];
  if (!hostname) return null;
  const [host, percent, zone] = partition(hostname, "%");
  return host.toLowerCase() + (percent ? "%" : "") + zone;
}

/** `SplitResult.port`: raises on a non-numeric or out-of-range port. */
function checkPort(netloc: string): void {
  const port = hostInfo(netloc)[1];
  if (port === null) return;
  if (!ASCII_DIGITS.test(port)) throw new UrlValueError("Port could not be cast to integer");
  if (BigInt(port) > 65535n) throw new UrlValueError("Port out of range 0-65535");
}

/** `(username, password)` of the netloc (Python `None` as null). */
function userInfo(netloc: string): [string | null, string | null] {
  const [userinfo, hasInfo] = rpartition(netloc, "@");
  if (!hasInfo) return [null, null];
  const [username, hasPassword, password] = partition(userinfo, ":");
  return [username, hasPassword ? password : null];
}

/** None (null) when `value` is an acceptable source URL, else the reason. */
export function checkUrl(value: unknown): string | null {
  if (typeof value !== "string" || !pyStrip(value)) return "is required (the article / report URL)";
  const url = pyStrip(value);
  if (Array.from(url).length > URL_MAX) return `is too long (max ${URL_MAX} characters)`;
  for (const ch of url) {
    if (isPySpace(ch.codePointAt(0) as number)) {
      return "must not contain spaces or control characters";
    }
  }
  if (CONTROL.test(url)) return "must not contain spaces or control characters";
  let parts: SplitUrl;
  let host: string;
  try {
    parts = urlsplit(url);
    host = (hostnameOf(parts.netloc) ?? "").toLowerCase().replace(/\.+$/, "");
    checkPort(parts.netloc);
  } catch (error) {
    if (error instanceof UrlValueError) return "is not a valid URL";
    throw error;
  }
  if (parts.scheme !== "http" && parts.scheme !== "https") return "must be an http(s) URL";
  const [username, password] = userInfo(parts.netloc);
  if (!host || username || password) return "must name a public host (no credentials)";
  if (ipKind(stripChars(host, "[]")) !== null) return "must use a host name, not an IP address";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  ) {
    return "must name a public host";
  }
  if (BYPASS_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) {
    return "is a paywall-bypass service; cite the original publisher's URL";
  }
  return null;
}
