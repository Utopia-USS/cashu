// S26 spec 5.2-5.3, gid.md 7.1: genesis device id, base wall W (future columns excluded, clock_skew),
// HLC sequence with counter overflow, eid stability. Vectors from Python's hmac (test salt 00..1f).
import { describe, expect, it } from "vitest";
import { parseHlc } from "../events/v1/hlc-format.js";
import { DEVICE_RE, ULID_RE } from "../events/v1/primitives.js";
import { vaultSalt } from "../gid.js";
import { GenesisClock, genesisDevice, genesisEid, genesisHlc, genesisWall } from "./clock.js";
import { GenesisError } from "./report.js";

const TEST_SALT = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i));
const OTHER_SALT = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
const W = Date.UTC(2026, 0, 1) + 1;
const NOW = Date.UTC(2026, 5, 1);

describe("genesisDevice", () => {
  it("is the first 16 bytes of HMAC(salt, label) as 32 hex (Python vector)", () => {
    expect(genesisDevice(TEST_SALT)).toBe("3dff8d011cf7b666d113ba55186bca5e");
    expect(genesisDevice(TEST_SALT)).toMatch(DEVICE_RE);
  });

  it("differs between vaults", () => {
    expect(genesisDevice(OTHER_SALT)).not.toBe(genesisDevice(TEST_SALT));
  });
});

describe("genesisWall", () => {
  it("is 1 + the newest happened-at timestamp, the fraction floored to milliseconds", () => {
    const wall = genesisWall(
      [
        ["created_at", "2025-12-31T23:59:59.999999Z"],
        ["updated_at", "2025-06-01T00:00:00Z"],
        ["read_at", null],
      ],
      NOW,
    );
    expect(wall).toBe(Date.UTC(2026, 0, 1));
  });

  it("skips the future-dated columns and payload keys", () => {
    const future = "2030-01-01T00:00:00Z";
    const wall = genesisWall(
      [
        ["created_at", "2026-01-01T00:00:00Z"],
        ["expires_at", future],
        ["snoozed_until", future],
        ["cooldown_until", future],
        ["expiresAt", future],
        ["snoozedUntil", future],
        ["cooldownUntil", future],
        ["until", future],
      ],
      NOW,
    );
    expect(wall).toBe(W);
  });

  it("fails clock_skew when W is more than 5 minutes ahead of now", () => {
    const stamps: [string, string][] = [["created_at", "2026-01-01T00:05:00Z"]];
    // W = 00:05:00.001: exactly now + 5 min passes, one millisecond less fails.
    expect(genesisWall(stamps, Date.UTC(2026, 0, 1, 0, 0, 0, 1))).toBe(
      Date.UTC(2026, 0, 1, 0, 5) + 1,
    );
    let error: unknown;
    try {
      genesisWall(stamps, Date.UTC(2026, 0, 1));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GenesisError);
    expect((error as GenesisError).code).toBe("clock_skew");
  });

  it("refuses a value that is not a timestamp, and a vault without any", () => {
    expect(() => genesisWall([["created_at", "2026-01-01"]], NOW)).toThrow(RangeError);
    expect(() => genesisWall([["expires_at", "2026-01-01T00:00:00Z"]], NOW)).toThrow(RangeError);
  });
});

describe("genesisHlc", () => {
  it("counts n on the wall W, overflowing to W + 1 after zzzz", () => {
    const device = genesisDevice(TEST_SALT);
    expect(genesisHlc(W, 0, device)).toBe(`0mjuohs01-0000-${device}`);
    expect(genesisHlc(W, 1679615, device)).toBe(`0mjuohs01-zzzz-${device}`);
    expect(genesisHlc(W, 1679616, device)).toBe(`0mjuohs02-0000-${device}`);
    expect(parseHlc(genesisHlc(W, 1679617 + 36, device))).toEqual({
      wall: W + 1,
      counter: 37,
      device,
    });
  });

  it("is strictly increasing in n", () => {
    const device = genesisDevice(TEST_SALT);
    const hlcs = [0, 1, 2, 1679615, 1679616, 1679617, 3359232].map((n) => genesisHlc(W, n, device));
    expect([...hlcs].sort()).toEqual(hlcs);
    expect(new Set(hlcs).size).toBe(hlcs.length);
  });
});

describe("genesisEid", () => {
  const gid = "0123456789abcdef0123456789abcdef";

  it("is ULID(W, first 10 bytes of HMAC(salt, label US type US gid US k)) (Python vectors)", () => {
    expect(genesisEid(TEST_SALT, W, "profile.created", gid, 0)).toBe("01KDVDNA01CT6GBTT8V559YDZF");
    expect(
      genesisEid(TEST_SALT, W, "module.disabled", "fdb0a016-38e3-8d64-8dec-88673f5cdcda", 1),
    ).toBe("01KDVDNA01ZFMY9CWJQ8A18Z13");
  });

  it("depends on the salt, type, gid and k only", () => {
    const a = genesisEid(TEST_SALT, W, "note.added", gid, 0);
    expect(a).toMatch(ULID_RE);
    expect(genesisEid(TEST_SALT, W, "note.added", gid, 0)).toBe(a);
    expect(genesisEid(TEST_SALT, W, "note.read", gid, 0)).not.toBe(a);
    expect(genesisEid(TEST_SALT, W, "note.added", gid, 1)).not.toBe(a);
    expect(genesisEid(OTHER_SALT, W, "note.added", gid, 0)).not.toBe(a);
  });
});

describe("GenesisClock", () => {
  it("hands out consecutive HLCs and k per (type, gid)", () => {
    const clock = new GenesisClock(TEST_SALT, W);
    expect(clock.at).toBe("2026-01-01T00:00:00.001Z");
    const a = clock.next("module.enabled", "g1");
    const b = clock.next("module.disabled", "g1");
    const c = clock.next("module.enabled", "g1");
    expect([a.hlc, b.hlc, c.hlc]).toEqual([0, 1, 2].map((n) => genesisHlc(W, n, clock.device)));
    expect(a.eid).toBe(genesisEid(TEST_SALT, W, "module.enabled", "g1", 0));
    expect(b.eid).toBe(genesisEid(TEST_SALT, W, "module.disabled", "g1", 0));
    expect(c.eid).toBe(genesisEid(TEST_SALT, W, "module.enabled", "g1", 1));
  });

  it("keeps an event's eid when unrelated events before it change the HLC counter", () => {
    const one = new GenesisClock(TEST_SALT, W);
    const two = new GenesisClock(TEST_SALT, W);
    two.next("balance.recorded", "other");
    expect(two.next("note.added", "n").eid).toBe(one.next("note.added", "n").eid);
  });
});
