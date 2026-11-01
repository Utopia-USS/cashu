// The genesis device (lead decision for S29c phase B2): the vault's initial history (the genesis
// stream, store genesis) is written under a dedicated device identity, created with the vault,
// certified by the recovery identity while the words are on screen, and RETIRED once the genesis
// stream is written, so it can never write again.
//
// - Its first frame introduces it: its own `device.added` with the recovery-issued certificate
//   (the registry's self lane; the gate verifies that frame's head with the certificate's key).
// - Its last batch is its self-revocation: every fold fixes a self-revocation's cut at the
//   statement's own position (revocations.ts), so any later frame of the genesis stream, whoever
//   holds the key, ends after the cut: its data is rejected and its statements never count.
// - `retireGenesis` returns that statement and a `done` that wipes the identity in memory once it is
//   written; the key must never be kept anywhere else (it is never stored).

import type { UnstampedEvent } from "../carrier.js";
import {
  certifyDevice,
  createDeviceIdentity,
  type DeviceIdentity,
  type RecoveryIdentity,
  type Sodium,
} from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";

export const GENESIS_DEVICE_NAME = "genesis";

export interface GenesisDevice {
  readonly identity: DeviceIdentity;
  /** Recovery-issued: the trust root vouches for exactly this key under this id. */
  readonly certificate: Uint8Array;
}

/**
 * Creates the genesis device of `vaultId` (with the vault, while the recovery identity is at hand).
 * `deviceId`: a fixed genesis id (store genesis derives it from the vault salt), else a fresh one.
 */
export function createGenesisDevice(
  sodium: Sodium,
  recovery: RecoveryIdentity,
  vaultId: string,
  deviceId?: string,
): GenesisDevice {
  const identity = createDeviceIdentity(sodium, deviceId);
  const certificate = certifyDevice(
    sodium,
    recovery,
    {
      deviceId: identity.deviceId,
      signPublicKey: identity.signPublicKey,
      boxPublicKey: identity.box.publicKey,
    },
    vaultId,
  );
  return { identity, certificate };
}

/** The genesis device's self-introduction: write it in the genesis stream's first frame. */
export function genesisAnnouncement(
  g: GenesisDevice,
  vaultId: string,
  eid: string,
): UnstampedEvent {
  const subject = {
    deviceId: g.identity.deviceId,
    signPublicKey: g.identity.signPublicKey,
    boxPublicKey: g.identity.box.publicKey,
  };
  return buildDeviceAdded(g.identity, vaultId, eid, subject, GENESIS_DEVICE_NAME, g.certificate);
}

/**
 * The genesis device's retirement (its self-revocation; the fold fixes the cut at its own
 * position). Write `event` as the genesis stream's last batch (signed by the identity), then call
 * `done`, which wipes the identity: nothing can sign for the genesis device afterwards.
 */
export function retireGenesis(
  g: GenesisDevice,
  vaultId: string,
  eid: string,
): { readonly event: UnstampedEvent; readonly done: () => void } {
  const event = buildDeviceRevoked(g.identity, vaultId, eid, [
    { device: g.identity.deviceId, cut: { seg: 1, offset: 0 } },
  ]);
  return { event, done: () => g.identity.wipe() };
}
