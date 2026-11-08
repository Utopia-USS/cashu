// Exhaustive tier: a registry larger than one pairing message (PAGE_SIZE + 1 authentic statements)
// arrives in pages, bound by the signed hash. It stays the only test of paging. Cost (S29c B2): the
// statements are signed once (~0.5 ms each on @noble) and verified once in the process: the joiner's
// signature caches are seeded with the inviter's (verification results are a function of the bytes,
// so the fold computes the same registry; per-device verification is covered by every other pairing
// test), and the registry is one statement past a page instead of 100. A cheaper verifier (the S29c
// spec 12.4 follow-up) would bring it back to the default tier.

import { describe, expect, it } from "vitest";
import { createSimVault, newEid, pairDevice } from "../testing/devices/testkit.js";
import { buildDeviceAdded } from "./events.js";
import { PAGE_SIZE } from "./pairing.js";

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
      Array.from({ length: PAGE_SIZE + 1 }, () =>
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
    const phone = await pairDevice(creator, "phone", 0, { sharedCaches: true });
    expect(phone.devices.registry.isTrusted(phone.id)).toBe(true);
    expect(phone.devices.registry.events.length).toBe(creator.devices.registry.events.length);
  });
});
