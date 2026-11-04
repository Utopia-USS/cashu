import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { DeviceIdentity, encodeHead, signHead, verifyContextSignature } from "../crypto/index.js";
import { Secret } from "../crypto/secret.js";
import { concat, fromHex, lp, toHex, utf8 } from "./bytes.js";
import {
  buildHeadsGossiped,
  decodeHeadsGossiped,
  HEADS_GOSSIPED,
  statementBody,
} from "./events.js";

const VAULT = "00112233445566778899aabbccddeeff";
const DEVICE = "11223344556677889900aabbccddeeff";
const EID = "01K7B0X0000000000000000000";
const signSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 16);
const boxSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 48);
const HEAD =
  "11223344556677889900aabbccddeeff01000000070000000000000080" +
  "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5" +
  "2151defce24462f9a84b548a1553a3d5538d6a29d36ae9362c867936c7333769" +
  "75dcdbcf123ab1cb6fd2f521d5a09ff05863162142b12310385bfa25bff64b0a";
const SIGNATURE =
  "8d72d4eb3d55c797f0e90defdfc1a0609d00b772b2639ce691ecc04865c0f8e6" +
  "a74c496cab039521f970bea2c0888c1b4981475b30e14faa650c88baf728c006";

describe("device.headsGossiped v1 wire vector", () => {
  it("binds a canonical signed head to the distinct gossip signature domain", () => {
    const writer = new DeviceIdentity(DEVICE, new Secret(boxSeed), new Secret(signSeed));
    const head = signHead(writer, VAULT, {
      device: DEVICE,
      stream: 1,
      seg: 7,
      offset: 128,
      chain: new Uint8Array(32).fill(0xa5),
    });
    const event = buildHeadsGossiped(writer, VAULT, EID, [head]);
    const data = decodeHeadsGossiped(event.d);
    expect(event).toMatchObject({ t: HEADS_GOSSIPED, v: 1, i: EID });
    expect(data?.heads).toEqual([encodeHead(head)]);
    expect(encodeHead(head)).toBe(HEAD);
    expect(data?.signer).toBe(DEVICE);
    const body = statementBody(VAULT, HEADS_GOSSIPED, EID, event.d);
    const signature = fromHex(data?.sig ?? "");
    const canonical = `{"heads":["${HEAD}"],"signer":"${DEVICE}"}`;
    const expectedBody = concat(
      lp(utf8(VAULT)),
      lp(utf8(HEADS_GOSSIPED)),
      lp(utf8(EID)),
      lp(utf8(canonical)),
    );
    expect(toHex(body)).toBe(toHex(expectedBody));
    expect(toHex(signature)).toBe(SIGNATURE);
    const independentlySigned = ed25519.sign(concat(utf8("cashu/gossip/v1"), body), signSeed);
    expect(toHex(signature)).toBe(toHex(independentlySigned));
    expect(verifyContextSignature("cashu/gossip/v1", body, signature, writer.signPublicKey)).toBe(
      true,
    );
    expect(
      verifyContextSignature("cashu/gossip/v1", body, signature, ed25519.getPublicKey(boxSeed)),
    ).toBe(false);
    expect(verifyContextSignature("cashu/registry/v1", body, signature, writer.signPublicKey)).toBe(
      false,
    );
    expect(verifyContextSignature("cashu/lease/v1", body, signature, writer.signPublicKey)).toBe(
      false,
    );
    expect(decodeHeadsGossiped({ ...event.d, heads: [HEAD.toUpperCase()] })).toBeUndefined();
  });
});
