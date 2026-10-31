// Exhaustive tier: a registry larger than one pairing message (PAGE_SIZE + 100 authentic statements)
// arrives in pages, bound by the signed hash. It stays the only test of paging: every statement must
// be signed and verified (about 1,200 Ed25519 checks on @noble), which no default-tier case can
// afford; a cheaper verifier (the follow-up the S29c spec measures in 12.4) brings it back.

import { describe, expect, it } from "vitest";
import { buildDeviceAdded } from "./events.js";
import { PAGE_SIZE } from "./pairing.js";
import { createSimVault, newEid, pairDevice } from "./testkit.js";

describe("pairing: registry pages (review M4)", () => {
  it("a registry larger than one message arrives in pages, bound by the signed hash", async () => {
    const { creator } = createSimVault();
    const subject = {
      deviceId: creator.id,
      signPublicKey: creator.identity.signPublicKey,
      boxPublicKey: creator.identity.box.publicKey,
    };
    const cert = creator.stream[0]?.events[0]?.data.certificate as string;
    const certBytes = Uint8Array.from(Buffer.from(cert, "hex"));
    creator.write(
      Array.from({ length: PAGE_SIZE + 100 }, () =>
        buildDeviceAdded(
          creator.identity,
          creator.ring.vaultId,
          newEid(),
          subject,
          "creator",
          certBytes,
        ),
      ),
    );
    creator.push();
    expect(creator.devices.registry.events.length).toBeGreaterThan(PAGE_SIZE);
    const phone = await pairDevice(creator, "phone");
    expect(phone.devices.registry.isTrusted(phone.id)).toBe(true);
    expect(phone.devices.registry.events.length).toBe(creator.devices.registry.events.length);
  });
});
