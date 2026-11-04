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
// positions is replayed. Proven forks are NOT in the snapshot: they live in their own append-only
// evidence record (`encodeEvidence`), restored before any snapshot, so a rollback cannot lose one.

import { decodeHead, encodeHead, type SignedHead } from "../crypto/index.js";
import { accepted, acceptedHead } from "./acceptance.js";
import { concat, fromHex, isHex, isRecord, lp, toHex, utf8 } from "./bytes.js";
import type { LogEvent } from "./events.js";
import { decodeHeadsGossiped, HEADS_GOSSIPED } from "./events.js";
import { MAX_GOSSIP_HISTORY } from "./gossip.js";
import type { StatementVerifier } from "./statements.js";

const VERSION = 2;
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
  readonly gossip: readonly LogEvent[];
  readonly anchors: readonly SignedHead[];
  readonly freezeFloors: readonly (readonly [
    string,
    { readonly seg: number; readonly offset: number },
  ])[];
  readonly ledger: {
    readonly frontiers: readonly string[];
    readonly proofs: readonly string[];
    readonly ordinary: readonly string[];
    readonly overflow: boolean;
    readonly overflowDevices: readonly string[];
  };
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
    gossip: snapshot.gossip,
    anchors: snapshot.anchors.map(encodeHead),
    freezeFloors: snapshot.freezeFloors.map(([device, end]) => [device, end.seg, end.offset]),
    ledger: snapshot.ledger,
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
  const gossip = all(raw.gossip, logEvent);
  const anchors = all(raw.anchors, decodeHead);
  const freezeFloors = all(
    raw.freezeFloors,
    (value): [string, { seg: number; offset: number }] | undefined =>
      Array.isArray(value) && isDevice(value[0]) && isPosInt(value[1]) && isPosInt(value[2])
        ? [value[0], { seg: value[1], offset: value[2] }]
        : undefined,
  );
  const ledger = isRecord(raw.ledger) ? raw.ledger : undefined;
  const frontiers = all(ledger?.frontiers, (value) =>
    decodeHead(value) ? (value as string) : undefined,
  );
  const proofs = all(ledger?.proofs, (value) =>
    decodeHead(value) ? (value as string) : undefined,
  );
  const ordinary = all(ledger?.ordinary, (value) =>
    decodeHead(value) ? (value as string) : undefined,
  );
  // The signed snapshot must identify each writer whose proof bound overflowed.
  const overflowDevices = all(ledger?.overflowDevices, (value) =>
    isDevice(value) ? value : undefined,
  );
  const applied = all(raw.applied, (a): [string, { seg: number; offset: number }] | undefined =>
    Array.isArray(a) && isDevice(a[0]) && isPosInt(a[1]) && isPosInt(a[2])
      ? [a[0], { seg: a[1], offset: a[2] }]
      : undefined,
  );
  if (
    !positions ||
    !keys ||
    !heads ||
    !statements ||
    !applied ||
    !gossip ||
    !anchors ||
    !freezeFloors ||
    !frontiers ||
    !proofs ||
    !ordinary ||
    !overflowDevices ||
    typeof ledger?.overflow !== "boolean" ||
    ledger.overflow !== overflowDevices.length > 0
  )
    return undefined;
  if (
    keys.length > 2048 ||
    heads.length > 4096 ||
    gossip.length > MAX_GOSSIP_HISTORY ||
    anchors.length > 1024 ||
    freezeFloors.length > 1024 ||
    proofs.length > MAX_GOSSIP_HISTORY ||
    frontiers.length > 1024 ||
    ordinary.length > 1024 ||
    overflowDevices.length > 1024
  )
    return undefined;
  if (gossip.some((e) => e.type !== HEADS_GOSSIPED || e.v !== 1 || !decodeHeadsGossiped(e.data)))
    return undefined;
  if ([frontiers, proofs, ordinary].some((xs) => new Set(xs).size !== xs.length)) return undefined;
  if (new Set(overflowDevices).size !== overflowDevices.length) return undefined;
  if (new Set(freezeFloors.map(([device]) => device)).size !== freezeFloors.length)
    return undefined;
  const bound = new Map(keys.map(([d, stream, key]) => [`${d}|${stream}`, key]));
  for (const encoded of [...frontiers, ...proofs, ...ordinary]) {
    const head = decodeHead(encoded);
    const key = head && bound.get(`${head.device}|1`);
    if (
      head?.stream !== 1 ||
      !key ||
      !acceptedHead(verify, vaultId, head, { kind: "author", keys: [key] })
    )
      return undefined;
  }
  const stored = new Set<string>();
  for (const head of anchors) {
    const key = bound.get(`${head.device}|1`);
    if (
      head.stream !== 1 ||
      !key ||
      !acceptedHead(verify, vaultId, head, { kind: "author", keys: [key] })
    )
      return undefined;
  }
  for (const { head } of heads) {
    const key = bound.get(`${head.device}|1`);
    if (head.stream !== 1 || !key) return undefined;
    if (!acceptedHead(verify, vaultId, head, { kind: "author", keys: [key] })) return undefined;
    stored.add(`${head.device}|${head.seg}:${head.offset}`);
  }
  for (const [device, end] of applied) {
    if ((end.seg !== 1 || end.offset !== 0) && !stored.has(`${device}|${end.seg}:${end.offset}`))
      return undefined;
  }
  for (const head of positions) {
    const key = bound.get(`${head.device}|1`);
    if (head.stream !== 1 || !key) return undefined;
    if (!acceptedHead(verify, vaultId, head, { kind: "author", keys: [key] })) return undefined;
  }
  return {
    positions,
    keys,
    heads,
    statements,
    applied,
    gossip,
    anchors,
    freezeFloors,
    ledger: { frontiers, proofs, ordinary, overflow: ledger.overflow, overflowDevices },
  };
}

/**
 * A fork proof of the evidence record (kept outside the snapshot, append only): two heads of one
 * writer at one end with different chains, as `<head hex> <head hex>`.
 */
export function encodeEvidence(pair: readonly [SignedHead, SignedHead]): string {
  const [first, second] = pair.map(encodeHead).sort();
  return `${first} ${second}`;
}

/** Strict decode of `encodeEvidence`: undefined unless it is such a pair. */
export function decodeEvidence(record: string): [SignedHead, SignedHead] | undefined {
  const [a, b, ...rest] = record.split(" ");
  const x = decodeHead(a);
  const y = decodeHead(b);
  if (!x || !y || rest.length > 0) return undefined;
  const sameEnd =
    x.device === y.device && x.stream === y.stream && x.seg === y.seg && x.offset === y.offset;
  if (!sameEnd || x.stream !== 1 || toHex(x.chain) === toHex(y.chain)) return undefined;
  return [x, y];
}
