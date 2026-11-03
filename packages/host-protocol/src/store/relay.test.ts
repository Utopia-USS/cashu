import { describe, expect, it } from "vitest";
import { STORE_PROTOCOL_VERSION } from "./messages.js";
import { LINK_STATES, relayToClientSchema } from "./relay.js";

describe("desktop relay messages", () => {
  it("carries the host's store messages and main's link states", () => {
    for (const state of LINK_STATES) {
      expect(relayToClientSchema.parse({ t: "link", state })).toEqual({ t: "link", state });
    }
    expect(
      relayToClientSchema.parse({
        t: "ready",
        protocol: STORE_PROTOCOL_VERSION,
        vaults: ["0".repeat(32)],
      }),
    ).toMatchObject({ t: "ready" });
    expect(relayToClientSchema.parse({ t: "value", sid: 3, value: { a: 1 } })).toMatchObject({
      t: "value",
    });
  });

  it("refuses unknown link states and store messages of another version", () => {
    expect(relayToClientSchema.safeParse({ t: "link", state: "gone" }).success).toBe(false);
    expect(relayToClientSchema.safeParse({ t: "ready", protocol: 1, vaults: [] }).success).toBe(
      false,
    );
  });
});
