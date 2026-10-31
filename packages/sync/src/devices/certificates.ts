// Which logged certificates the registry counts (review M4, S29c R2).
//
// A certificate carried by a `device.added` event counts only in one of three lanes, decided from the
// event and the certificate alone (no signature work):
// - own:      a device-issued certificate in its ISSUER's own stream, statement signed by that writer
//             (pairing: the inviter writes what it certified);
// - self:     a recovery-issued certificate announced by its SUBJECT in its own stream, statement
//             signed by that writer (vault creation: the creator announces itself);
// - recovery: a recovery-issued certificate in a recovery-signed statement, in any writer's stream
//             (the owner re-certifies a device with the words).
// Anything else is `foreign_certificate`: no honest code path writes another issuer's certificate.
//
// Work and quota are bounded per WRITER stream, never per issuer: within one writer's stream (and
// lane issuer) the candidates are walked in stream order, at most CERT_CHECK_BUDGET are checked and
// at most MAX_CERTS_PER_ISSUER count. Recovery-issued candidates have both signatures checked
// (certificate under the pinned recovery key, statement under the recovery key or the subject's
// certified key) BEFORE they can use up the quota, so junk in one stream can only crowd that stream:
// a writer cannot push the creator's or another writer's certificates out (the 300-junk attack).
// Device-issued candidates are checked against their issuer's certified keys once the recovery-rooted
// certificates are known (one breadth-first closure).

import {
  type CertificateCache,
  CertificateIndex,
  type ParsedCertificate,
  parseCertificate,
  RECOVERY_SIGNER_ID,
  type Sodium,
} from "../crypto/index.js";
import { fromHex } from "./bytes.js";
import { type DeviceAddedData, MAX_DEVICES, statementBody } from "./events.js";
import { comparePositions } from "./positions.js";
import {
  CERT_CHECK_BUDGET,
  type Decoded,
  type IgnoredReason,
  MAX_CERTS_PER_ISSUER,
  type TrustRoot,
} from "./registryTypes.js";
import type { StatementVerifier } from "./statements.js";
import { cmp, push } from "./util.js";

type Lane = "own" | "self" | "recovery";

interface Candidate {
  readonly added: Decoded<DeviceAddedData>;
  readonly parsed: ParsedCertificate;
  readonly lane: Lane;
}

export interface CertificateInput {
  readonly sodium: Sodium;
  readonly root: TrustRoot;
  readonly cache: CertificateCache;
  readonly bootstrap: readonly Uint8Array[];
  readonly added: readonly Decoded<DeviceAddedData>[];
  readonly verify: StatementVerifier;
  /** The recovery signing keys a recovery-signed statement with this eid may verify with. */
  readonly recoveryKeysFor: (eid: string) => readonly Uint8Array[];
}

export interface CertificateSelection {
  /** Bootstrap certificates plus the logged ones that count. */
  readonly certificates: Uint8Array[];
  /** Per `writer|lane issuer` window: the certificates kept (what room a writer has left). */
  readonly windows: Map<string, number>;
  /** Per device issuer: its own-stream certificates that count (the pairing capacity). */
  readonly issued: Map<string, number>;
  /** `device.added` events whose certificate does not count, with the reason (copies excluded). */
  readonly rejected: Map<Decoded<DeviceAddedData>, IgnoredReason>;
}

export function selectCertificates(input: CertificateInput): CertificateSelection {
  const { root, cache, verify } = input;
  const rejected = new Map<Decoded<DeviceAddedData>, IgnoredReason>();
  // --- Admission: lanes, grouped by (writer, lane issuer).
  const groups = new Map<string, Candidate[]>();
  for (const added of input.added) {
    const parsed = parseCertificate(fromHex(added.data.certificate));
    if (!parsed) {
      rejected.set(added, "malformed");
      continue;
    }
    const lane = laneOf(added, parsed);
    if (!lane) {
      rejected.set(added, "foreign_certificate");
      continue;
    }
    const issuer = lane === "own" ? parsed.signerId : RECOVERY_SIGNER_ID;
    push(groups, `${added.event.writer}|${issuer}`, { added, parsed, lane });
  }
  for (const list of groups.values()) list.sort(byStreamOrder);

  // A certificate-only index: signature checks through the shared cache.
  const checker = new CertificateIndex(
    input.sodium,
    root.vaultId,
    root.recovery.signPublicKey,
    [],
    {
      cache,
    },
  );
  const statementSignedBy = (c: Candidate, keys: readonly Uint8Array[]): boolean => {
    const { event, data } = c.added;
    const body = statementBody(root.vaultId, event.type, event.eid, event.data);
    const sig = fromHex(data.sig);
    return keys.some((k) => verify("cashu/registry/v1", body, sig, k));
  };

  // --- Recovery-issued certificates: both signatures, per writer window.
  const certificates: Uint8Array[] = input.bootstrap.map((c) => c.slice());
  const own: Candidate[][] = [];
  const counts = new Map<string, number>();
  for (const [window, list] of groups) {
    if (list[0]?.lane === "own") {
      own.push(list);
      continue;
    }
    const valid = walkWindow(list, rejected, (c) => {
      const bytes = fromHex(c.added.data.certificate);
      if (!checker.isSignedBy(bytes, root.recovery.signPublicKey)) return false;
      const keys =
        c.lane === "recovery" ? input.recoveryKeysFor(c.added.event.eid) : [c.parsed.signPublicKey];
      return statementSignedBy(c, keys);
    });
    counts.set(window, valid.length);
    for (const c of valid) certificates.push(fromHex(c.added.data.certificate));
  }

  // --- Device-issued certificates: checked under the issuer's certified keys (one closure over the
  // recovery-rooted certificates and each issuer's first CERT_CHECK_BUDGET candidates).
  const windows = own.map((list) => firstDistinct(list, CERT_CHECK_BUDGET, rejected));
  const pre = new CertificateIndex(
    input.sodium,
    root.vaultId,
    root.recovery.signPublicKey,
    [...certificates, ...windows.flat().map((c) => fromHex(c.added.data.certificate))],
    { cache, maxDevices: MAX_DEVICES },
  );
  const reach = pre.closure(new Set());
  const issued = new Map<string, number>();
  for (const list of windows) {
    const issuer = list[0]?.parsed.signerId;
    if (issuer === undefined) continue;
    const keys = reach.keysOf(issuer).map((k) => k.signPublicKey);
    const valid = walkWindow(list, rejected, (c) => {
      const bytes = fromHex(c.added.data.certificate);
      return keys.some((k) => pre.isSignedBy(bytes, k));
    });
    issued.set(issuer, valid.length);
    counts.set(`${issuer}|${issuer}`, valid.length);
    for (const c of valid) certificates.push(fromHex(c.added.data.certificate));
  }
  return { certificates, windows: counts, issued, rejected };
}

function laneOf(added: Decoded<DeviceAddedData>, parsed: ParsedCertificate): Lane | undefined {
  const writer = added.event.writer;
  const signer = added.data.signer;
  if (parsed.signerId !== RECOVERY_SIGNER_ID) {
    return writer === parsed.signerId && signer === writer ? "own" : undefined;
  }
  if (signer === RECOVERY_SIGNER_ID) return "recovery";
  return writer === parsed.subjectId && signer === writer ? "self" : undefined;
}

/** Stream order of the carrying events; ties (copies at one position) by content, so sets decide. */
function byStreamOrder(a: Candidate, b: Candidate): number {
  return (
    comparePositions(a.added.event.position, b.added.event.position) ||
    cmp(a.added.data.certificate, b.added.data.certificate) ||
    cmp(a.added.event.eid, b.added.event.eid) ||
    cmp(a.added.data.sig, b.added.data.sig) ||
    cmp(a.added.data.name, b.added.data.name)
  );
}

/**
 * Walks one writer's window in stream order: at most CERT_CHECK_BUDGET checks, at most
 * MAX_CERTS_PER_ISSUER kept. A copy of a kept certificate is skipped for free (not rejected).
 */
function walkWindow(
  list: readonly Candidate[],
  rejected: Map<Decoded<DeviceAddedData>, IgnoredReason>,
  valid: (c: Candidate) => boolean,
): Candidate[] {
  const kept: Candidate[] = [];
  const keptHex = new Set<string>();
  let checked = 0;
  for (const c of list) {
    if (keptHex.has(c.added.data.certificate)) continue;
    if (checked >= CERT_CHECK_BUDGET || kept.length >= MAX_CERTS_PER_ISSUER) {
      rejected.set(c.added, "capped");
      continue;
    }
    checked += 1;
    if (!valid(c)) {
      rejected.set(c.added, "bad_signature");
      continue;
    }
    kept.push(c);
    keptHex.add(c.added.data.certificate);
  }
  return kept;
}

/** The first `limit` distinct certificates of a window (and their copies); the rest are capped. */
function firstDistinct(
  list: readonly Candidate[],
  limit: number,
  rejected: Map<Decoded<DeviceAddedData>, IgnoredReason>,
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    const hex = c.added.data.certificate;
    if (!seen.has(hex)) {
      if (seen.size >= limit) {
        rejected.set(c.added, "capped");
        continue;
      }
      seen.add(hex);
    }
    out.push(c);
  }
  return out;
}
