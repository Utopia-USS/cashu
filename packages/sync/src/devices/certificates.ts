// The per-issuer certificate cap of the registry (review M4).

import type { SegmentCursor } from "../carrier.js";
import {
  type CertificateCache,
  CertificateIndex,
  parseCertificate,
  RECOVERY_SIGNER_ID,
  type Sodium,
} from "../crypto/index.js";
import { fromHex } from "./bytes.js";
import { type DeviceAddedData, MAX_DEVICES } from "./events.js";
import { comparePositions } from "./positions.js";
import { type Decoded, MAX_CERTS_PER_ISSUER, type TrustRoot } from "./registryTypes.js";
import { cmp } from "./util.js";

/**
 * Bootstrap certificates plus the logged ones within the per-issuer cap. An issuer's certificates
 * are ranked by the position of the first `device.added` carrying them in the ISSUER's own stream
 * (certificates only seen in other streams rank last), then by bytes. Only certificates whose
 * signature verifies under a certified key of their issuer count toward its quota, so junk (forged
 * or unsigned) never consumes capacity, and nobody but the issuer can push its real certificates out
 * of the quota. At most 4 x the cap are even checked per issuer (bounding the work junk can cause).
 * `issued` counts the kept certificates the issuer wrote itself (the pairing capacity).
 */
export function cappedCertificates(
  sodium: Sodium,
  root: TrustRoot,
  cache: CertificateCache,
  bootstrap: readonly Uint8Array[],
  added: readonly Decoded<DeviceAddedData>[],
): { certificates: Uint8Array[]; issued: Map<string, number> } {
  const byIssuer = new Map<string, Map<string, SegmentCursor | undefined>>();
  for (const { event, data } of added) {
    const parsed = parseCertificate(fromHex(data.certificate));
    if (!parsed) continue;
    const ranks = byIssuer.get(parsed.signerId) ?? new Map<string, SegmentCursor | undefined>();
    const own = event.writer === parsed.signerId ? event.position : undefined;
    const prior = ranks.get(data.certificate);
    if (!ranks.has(data.certificate) || (own && (!prior || comparePositions(own, prior) < 0))) {
      ranks.set(data.certificate, own ?? prior);
    }
    byIssuer.set(parsed.signerId, ranks);
  }
  const ranked = new Map<string, [string, SegmentCursor | undefined][]>();
  for (const [issuer, ranks] of byIssuer) {
    ranked.set(
      issuer,
      [...ranks]
        .sort(([ha, pa], [hb, pb]) => {
          if (pa && pb) return comparePositions(pa, pb) || cmp(ha, hb);
          if (pa || pb) return pa ? -1 : 1;
          return cmp(ha, hb);
        })
        .slice(0, 4 * MAX_CERTS_PER_ISSUER),
    );
  }
  const base: Uint8Array[] = bootstrap.map((c) => c.slice());
  const considered = [...ranked.values()].flatMap((list) => list.map(([hex]) => fromHex(hex)));
  const pre = new CertificateIndex(
    sodium,
    root.vaultId,
    root.recovery.signPublicKey,
    [...base, ...considered],
    { cache, maxDevices: MAX_DEVICES },
  );
  const reach = pre.closure(new Set());
  const certificates = [...base];
  const issued = new Map<string, number>();
  for (const [issuer, list] of ranked) {
    const keys =
      issuer === RECOVERY_SIGNER_ID
        ? [root.recovery.signPublicKey]
        : reach.keysOf(issuer).map((k) => k.signPublicKey);
    const kept = list
      .filter(([hex]) => keys.some((k) => pre.isSignedBy(fromHex(hex), k)))
      .slice(0, MAX_CERTS_PER_ISSUER);
    issued.set(issuer, kept.filter(([, own]) => own !== undefined).length);
    for (const [hex] of kept) certificates.push(fromHex(hex));
  }
  return { certificates, issued };
}
