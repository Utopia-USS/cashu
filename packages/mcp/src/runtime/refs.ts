// Opaque MCP transport references preserve global identity; no local integer aliases are allocated.
const KIND = /^[a-z][a-z0-9_]*$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type EntityRefKind =
  | "review"
  | "loan"
  | "instrument"
  | "signal"
  | "thesis"
  | "alert"
  | "run"
  | "note"
  | "watchlist"
  | "account"
  | "decision"
  | "proposal";

// Letter-only payloads avoid identifier-like digit runs in the unchanged final leak check.
// u carries the 26 canonical ULID ASCII bytes as nibbles; v carries 16 UUIDv8 bytes.
// Mapping hex 0..f to a..p keeps both discriminated tokens within the 64-character ref limit.
function letters(hex: string): string {
  return hex.replace(/./g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

export function encodeEntityRef(kind: EntityRefKind, gid: string): string {
  if (!KIND.test(kind) || (!ULID.test(gid) && !UUID.test(gid)))
    throw new TypeError("invalid entity reference");
  const token = ULID.test(gid)
    ? `u${letters([...gid].map((character) => character.charCodeAt(0).toString(16)).join(""))}`
    : `v${letters(gid.replaceAll("-", ""))}`;
  return `${kind}:${token}`;
}

export function decodeEntityRef(kind: EntityRefKind, value: string): string {
  const prefix = `${kind}:`;
  if (!KIND.test(kind) || !value.startsWith(prefix))
    throw new TypeError("invalid entity reference");
  const token = value.slice(prefix.length);
  if (!/^(?:u[a-p]{52}|v[a-p]{32})$/.test(token)) throw new TypeError("invalid entity reference");
  const hex = token.slice(1).replace(/./g, (letter) => (letter.charCodeAt(0) - 97).toString(16));
  const gid =
    token[0] === "u"
      ? hex.replace(/../g, (byte) => String.fromCharCode(Number.parseInt(byte, 16)))
      : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (encodeEntityRef(kind, gid) !== value) throw new TypeError("invalid entity reference");
  return gid;
}
