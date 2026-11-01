// The frame gate's snapshot (S29c-B3, lead decision on B2 deviation 3): a restart restores the
// device state from it and replays only the frames after its positions, instead of opening and
// verifying the whole local log again (needed before the phone).
//
// What it holds: the statements the gate ingested (`device.*` / `lease.*` events with their writer
// and position: restoring re-runs the folds over them, so the registry, lease and freezes are
// recomputed exactly as a replay would, signatures included), the stream index (bound keys and every
// verified data head with the chains seen at its end), the guard's accepted ends, and per writer the
// signed head of the last frame the gate accepted (the positions). Local clock readings (lease
// first-seen times) are not kept: a restart sees them anew, as a full replay does.
//
// Why it can be trusted: the text is signed by this device's own identity (`cashu/state/v1`, the
// `self` key source of acceptance.ts), bound to the vault and device, so a corrupt, foreign or forged
// snapshot (a dropped revocation re-signed by anyone else) does not authenticate; each position's
// head must verify under the key its stream is bound to; and the engine then finds each position's
// frame in the local log with the same chain and signature (a rewritten or truncated log, or a
// snapshot of another log, fails there). Any failure: the snapshot is ignored and the log replayed.
// A genuine older snapshot (a view database rolled back) is harmless: everything after its
// positions is replayed.

import { decodeHead, encodeHead, type SignedHead } from "../crypto/index.js";
import { accepted, acceptedHead } from "./acceptance.js";
import { concat, fromHex, isHex, isRecord, lp, toHex, utf8 } from "./bytes.js";
import type { LogEvent } from "./events.js";
import type { StatementVerifier } from "./statements.js";

const VERSION = 1;
const SIG_HEX = 128;

export interface GateSnapshot {
  readonly positions: readonly SignedHead[];
  readonly keys: readonly (readonly [string, 0 | 1, Uint8Array])[];
  readonly heads: readonly { readonly head: SignedHead; readonly others: readonly string[] }[];
  readonly statements: readonly LogEvent[];
  readonly applied: readonly (readonly [
    string,
    { readonly seg: number; readonly offset: number },
  ])[];
}

function signedBody(vaultId: string, deviceId: string, json: string): Uint8Array {
  return concat(lp(utf8(vaultId)), lp(utf8(deviceId)), utf8(json));
}

/** The snapshot as text: canonical-enough JSON, a newline, the signature in hex. */
export function encodeGateState(
  vaultId: string,
  deviceId: string,
  snapshot: GateSnapshot,
  sign: (body: Uint8Array) => Uint8Array,
): string {
  const json = JSON.stringify({
    v: VERSION,
    vault: vaultId,
    device: deviceId,
    positions: snapshot.positions.map(encodeHead),
    keys: snapshot.keys.map(([d, stream, key]) => [d, stream, toHex(key)]),
    heads: snapshot.heads.map((h) => [encodeHead(h.head), h.others]),
    statements: snapshot.statements,
    applied: snapshot.applied.map(([d, at]) => [d, at.seg, at.offset]),
  });
  return `${json}\n${toHex(sign(signedBody(vaultId, deviceId, json)))}`;
}

const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isDevice = (v: unknown): v is string => isHex(v, 16);

function cursor(v: unknown): { seg: number; offset: number } | undefined {
  return isRecord(v) && isPosInt(v.seg) && isPosInt(v.offset)
    ? { seg: v.seg, offset: v.offset }
    : undefined;
}

function logEvent(raw: unknown): LogEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const position = cursor(raw.position);
  const { eid, hlc, writer, type, v, data } = raw;
  if (
    typeof eid !== "string" ||
    typeof hlc !== "string" ||
    !isDevice(writer) ||
    !position ||
    typeof type !== "string" ||
    !isPosInt(v) ||
    !isRecord(data)
  ) {
    return undefined;
  }
  return { eid, hlc, writer, position, type, v, data };
}

function all<T>(values: unknown, parse: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: T[] = [];
  for (const v of values) {
    const parsed = parse(v);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

/**
 * Parses and authenticates a snapshot of `deviceId` in `vaultId` signed by `signKey` (this device's
 * own key); undefined unless the signature, the shape and every position head (under its stream's
 * bound key in the snapshot) check out.
 */
export function decodeGateState(
  text: string,
  vaultId: string,
  deviceId: string,
  signKey: Uint8Array,
  verify: StatementVerifier,
): GateSnapshot | undefined {
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return undefined;
  const json = text.slice(0, cut);
  const sigHex = text.slice(cut + 1);
  if (sigHex.length !== SIG_HEX || !isHex(sigHex)) return undefined;
  const body = signedBody(vaultId, deviceId, json);
  if (!accepted(verify, "cashu/state/v1", body, fromHex(sigHex), { kind: "self", signKey })) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.v !== VERSION || raw.vault !== vaultId || raw.device !== deviceId) {
    return undefined;
  }
  const positions = all(raw.positions, decodeHead);
  const keys = all(raw.keys, (k): [string, 0 | 1, Uint8Array] | undefined =>
    Array.isArray(k) && isDevice(k[0]) && (k[1] === 0 || k[1] === 1) && isHex(k[2], 32)
      ? [k[0], k[1], fromHex(k[2])]
      : undefined,
  );
  const heads = all(raw.heads, (h) => {
    if (!Array.isArray(h)) return undefined;
    const head = decodeHead(h[0]);
    const others = all(h[1], (c) => (isHex(c, 32) ? c : undefined));
    return head && others ? { head, others } : undefined;
  });
  const statements = all(raw.statements, logEvent);
  const applied = all(raw.applied, (a): [string, { seg: number; offset: number }] | undefined =>
    Array.isArray(a) && isDevice(a[0]) && isPosInt(a[1]) && isPosInt(a[2])
      ? [a[0], { seg: a[1], offset: a[2] }]
      : undefined,
  );
  if (!positions || !keys || !heads || !statements || !applied) return undefined;
  const bound = new Map(keys.map(([d, stream, key]) => [`${d}|${stream}`, key]));
  for (const head of positions) {
    const key = bound.get(`${head.device}|1`);
    if (head.stream !== 1 || !key) return undefined;
    if (!acceptedHead(verify, vaultId, head, { kind: "author", keys: [key] })) return undefined;
  }
  return { positions, keys, heads, statements, applied };
}
