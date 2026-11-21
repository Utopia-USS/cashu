import { describe, expect, it } from "vitest";
import { parseRevokeIntentProof } from "./revokeIntent.js";

const A = "a".repeat(64);
const B = "0123456789abcdef".repeat(4);
const valid = { preview: A, digest: B, key: { kid: "k1", generation: 2, epoch: 3 } };

describe("parseRevokeIntentProof", () => {
  it("returns exactly the proof fields of a well formed fingerprint", () => {
    expect(parseRevokeIntentProof(JSON.stringify(valid))).toEqual(valid);
    const extra = { ...valid, note: "x", key: { ...valid.key, extra: true } };
    expect(parseRevokeIntentProof(JSON.stringify(extra))).toEqual(valid);
  });

  it("accepts every safe integer, including zero and negatives", () => {
    const key = { kid: "", generation: Number.MAX_SAFE_INTEGER, epoch: -Number.MAX_SAFE_INTEGER };
    expect(parseRevokeIntentProof(JSON.stringify({ ...valid, key })).key).toEqual(key);
  });

  it("throws the JSON parser's own error on malformed JSON", () => {
    expect(() => parseRevokeIntentProof("{")).toThrow(SyntaxError);
    expect(() => parseRevokeIntentProof("")).toThrow(SyntaxError);
  });

  const corrupt: readonly [string, unknown][] = [
    ["null", null],
    ["a string", "proof"],
    ["a number", 7],
    ["an array", [valid]],
    ["no key", { preview: A, digest: B }],
    ["a null key", { ...valid, key: null }],
    ["a string key", { ...valid, key: "k1" }],
    ["an array key", { ...valid, key: [] }],
    ["a missing preview", { digest: B, key: valid.key }],
    ["an uppercase preview", { ...valid, preview: A.toUpperCase() }],
    ["a short digest", { ...valid, digest: B.slice(1) }],
    ["a long digest", { ...valid, digest: `${B}0` }],
    ["a numeric digest", { ...valid, digest: 1 }],
    ["a numeric kid", { ...valid, key: { ...valid.key, kid: 1 } }],
    ["a fractional generation", { ...valid, key: { ...valid.key, generation: 1.5 } }],
    ["a string generation", { ...valid, key: { ...valid.key, generation: "2" } }],
    ["an unsafe epoch", { ...valid, key: { ...valid.key, epoch: 2 ** 53 } }],
    ["a missing epoch", { ...valid, key: { kid: "k1", generation: 2 } }],
  ];
  it.each(corrupt)("refuses %s as corrupt_revoke_intent", (_, value) => {
    expect(() => parseRevokeIntentProof(JSON.stringify(value))).toThrow("corrupt_revoke_intent");
  });
});
