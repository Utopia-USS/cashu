// The injectable HMAC (S29c spec 10, D11): the noble default and the Node adapter reproduce RFC 4231
// and mint byte-identical DET gids; a store refuses an implementation that does not conform, so a
// broken native binding can never mint different gids. Synthetic data only.
import { describe, expect, it } from "vitest";
import { GID_TABLES } from "../events/v1/namespaces.js";
import { detGidFor, vaultSalt } from "../gid.js";
import { Store } from "../materialize.js";
import { builtinModules } from "../modules.js";
import { viewHash } from "../snapshot.js";
import { nodeHmacSha256 } from "../testing/node-hmac.js";
import { rng } from "../testing/random.js";
import { memoryDriver, openTestStore, TEST_SALT, TEST_VAULT, testUlid } from "../testing/store.js";
import {
  assertHmacConformance,
  HmacConformanceError,
  type HmacSha256,
  nobleHmacSha256,
} from "./hmac.js";

describe("injectable HMAC-SHA256", () => {
  it("the noble default and the Node adapter both pass RFC 4231", () => {
    expect(() => assertHmacConformance(nobleHmacSha256)).not.toThrow();
    expect(() => assertHmacConformance(nodeHmacSha256)).not.toThrow();
  });

  it("refuses an implementation off by one bit, or one that reuses its state", () => {
    const flipped: HmacSha256 = {
      keyed: (key) => {
        const mac = nodeHmacSha256.keyed(key);
        return (m) => {
          const out = mac(m);
          out[31] = (out[31] ?? 0) ^ 1;
          return out;
        };
      },
    };
    const stateful: HmacSha256 = {
      keyed: (key) => {
        let calls = 0;
        const mac = nodeHmacSha256.keyed(key);
        return (m) => (calls++ === 0 ? mac(m) : mac(new Uint8Array([...m, 0])));
      },
    };
    for (const impl of [flipped, stateful]) {
      expect(() => assertHmacConformance(impl)).toThrow(HmacConformanceError);
      expect(() =>
        Store.open({
          driver: memoryDriver(),
          vault: TEST_VAULT,
          salt: TEST_SALT,
          modules: builtinModules(),
          hmac: impl,
        }),
      ).toThrow(HmacConformanceError);
    }
  });

  it("mints byte-identical DET gids under both implementations (random salts, tables, parts)", () => {
    const next = rng(29);
    for (let round = 0; round < 50; round++) {
      const salt = vaultSalt(Uint8Array.from({ length: 32 }, () => Math.floor(next() * 256)));
      const noble = detGidFor(salt, nobleHmacSha256);
      const native = detGidFor(salt, nodeHmacSha256);
      for (const table of GID_TABLES) {
        const parts = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
          `p${Math.floor(next() * 1e9)}-zażółć`.slice(0, 1 + Math.floor(next() * 20)),
        );
        expect(native(table, parts)).toBe(noble(table, parts));
      }
    }
  });

  it("a store with the native HMAC builds the same view as one with the default", () => {
    const native = Store.open({
      driver: memoryDriver(),
      vault: TEST_VAULT,
      salt: TEST_SALT,
      modules: builtinModules(),
      hmac: nodeHmacSha256,
    });
    const noble = openTestStore();
    const at = "2026-10-31T12:00:00.000Z";
    const events = [1, 2, 3].map((n) => ({
      eid: testUlid("01JH", n),
      vault: TEST_VAULT,
      device: "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      hlc: `0mvwcmtc${n}-0000-daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      at,
      type: "categoryRule.set",
      v: 1,
      gid: noble.deps.det("category_rules", [`SKLEP ${n}`]),
      data: { merchantKey: `SKLEP ${n}`, category: "groceries", source: "manual", locked: false },
    }));
    for (const s of [native, noble]) {
      const r = s.applyEnvelopes(events);
      expect(r.parked).toBe(0);
      expect(r.applied).toBe(3);
    }
    expect(viewHash(native).hash).toBe(viewHash(noble).hash);
  });
});
