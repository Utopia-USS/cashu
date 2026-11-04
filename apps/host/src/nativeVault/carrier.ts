// The LAN carrier endpoint of a native vault: a trusted device's signed list / read / append of
// opaque log segments, served only after inbound history is pulled and authority re-checked.
import {
  LAN_CARRIER_PATH,
  type LanCarrierReply,
  lanAuthBody,
  lanBytesDigest,
} from "@cashu/host-protocol/pairing-lan";
import { crypto } from "@cashu/sync";
import { assertReplayedDeviceAuthority } from "../sync/keys/deviceAuthority.js";
import { type NativeVaultContext, profileGid } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { SessionGuards } from "./guards.js";
import type { NativeVaultSession } from "./types.js";

const MAX_APPEND_BYTES = 72 * 1024 * 1024;

type RefusalCode = Extract<LanCarrierReply, { kind: "refused" }>["code"];

export function carrierEndpoint(
  context: NativeVaultContext,
  guards: Pick<SessionGuards, "isCurrent" | "writesBlocked">,
  prunePairing: () => void,
): NativeVaultSession["carrierRequest"] {
  const { entry, store, engine, candidate, source, lanCarrier, queue, now } = context;
  const refused = (code: RefusalCode) => ({ v: 1 as const, kind: "refused" as const, code });
  return (request, expiresAt, onAuthorized) =>
    queue.run(async () => {
      if (
        !guards.isCurrent() ||
        request.vault !== entry.vaultId ||
        request.auth.vault !== entry.vaultId ||
        request.auth.device !== request.device ||
        now() > expiresAt
      )
        return refused("unavailable");
      if (request.method === "append" && guards.writesBlocked()) return refused("unavailable");
      const registered = candidate.devices.registry.trusted.get(request.device);
      if (!registered) return refused("unauthorized");
      const decodedBytes =
        request.bytes === undefined ? undefined : Buffer.from(request.bytes, "base64url");
      if (decodedBytes && decodedBytes.length > MAX_APPEND_BYTES) return refused("too_large");
      const body = lanAuthBody({
        purpose: "carrier",
        path: LAN_CARRIER_PATH,
        method: request.method,
        vault: request.vault,
        device: request.device,
        ...(request.writer === undefined ? {} : { writer: request.writer }),
        ...(request.seg === undefined ? {} : { seg: request.seg }),
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(decodedBytes === undefined ? {} : { bytesDigest: lanBytesDigest(decodedBytes) }),
        nonce: request.auth.nonce,
        expiresAt,
      });
      if (
        !crypto.verifyContextSignature(
          "cashu/lan-auth/v1",
          body,
          Buffer.from(request.auth.signature, "hex"),
          registered.signPublicKey,
        )
      )
        return refused("unauthorized");
      onAuthorized?.();
      try {
        prunePairing();
        // Pull and validate any mobile stream before exposing new opaque state. The vault
        // queue serializes this with revocation and native commands.
        await engine.sync();
        const recovered = await engine.recoverLocal();
        assertReplayedDeviceAuthority(candidate, recovered, profileGid(store));
        if (candidate.devices.rotationNeeded() !== undefined) return refused("unavailable");
        await crypto.saveKeyring(source.keyStore, candidate.ring);
        const refreshed = candidate.devices.registry.trusted.get(request.device);
        if (
          !refreshed ||
          !Buffer.from(refreshed.signPublicKey).equals(Buffer.from(registered.signPublicKey)) ||
          !Buffer.from(refreshed.boxPublicKey).equals(Buffer.from(registered.boxPublicKey))
        )
          return refused("unauthorized");
        if (request.method === "list") {
          const segments = await lanCarrier.list(entry.vaultId);
          return {
            v: 1,
            kind: "list",
            segments: segments.map((part) => ({
              writer: part.device,
              seg: part.seg,
              size: part.size,
            })),
          } as const;
        }
        if (
          request.writer === undefined ||
          request.seg === undefined ||
          request.offset === undefined
        )
          return refused("invalid");
        if (request.method === "read") {
          const bytes = await lanCarrier.read(
            entry.vaultId,
            request.writer,
            request.seg,
            request.offset,
          );
          return {
            v: 1,
            kind: "read",
            bytes: Buffer.from(bytes).toString("base64url"),
          } as const;
        }
        if (request.writer !== request.device || decodedBytes === undefined)
          return refused("unauthorized");
        const size = await lanCarrier.append(
          entry.vaultId,
          request.writer,
          request.seg,
          request.offset,
          decodedBytes,
        );
        // A successful remote append is promptly pulled through the authenticated engine.
        await engine.sync();
        return { v: 1, kind: "append", size, digest: lanBytesDigest(decodedBytes) } as const;
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "carrier_offset_conflict") return refused("offset_conflict");
        if (code === "carrier_too_large") return refused("too_large");
        warnCause("native_carrier_request_failed", error);
        return refused("unknown");
      }
    });
}
