import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeLanDescriptor,
  encodeLanDescriptor,
  LAN_CARRIER_PATH,
  LAN_PAIR_RESUME_PATH,
  lanAuthBody,
  lanBytesDigest,
} from "@cashu/host-protocol/pairing-lan";
import { crypto } from "@cashu/sync";
import { expect, it } from "vitest";

interface AuthVector {
  readonly descriptor: string;
  readonly signPublicKey: string;
  readonly append: { readonly bodyUtf8: string; readonly signature: string };
  readonly resume: { readonly bodyUtf8: string; readonly signature: string };
}

it("pins literal LAN descriptor, append and resume bytes and purpose-bound signatures", async () => {
  const vector = JSON.parse(
    await readFile(
      join(process.cwd(), "../../packages/host-protocol/spec/lan-auth-vector-v1.json"),
      "utf8",
    ),
  ) as AuthVector;
  const publicKey = Buffer.from(vector.signPublicKey, "hex");
  const identity = new crypto.DeviceIdentity(
    "b".repeat(32),
    new crypto.Secret(new Uint8Array(32).fill(6)),
    new crypto.Secret(new Uint8Array(32).fill(7)),
  );
  try {
    expect(Buffer.from(identity.signPublicKey)).toEqual(publicKey);
    const descriptor = decodeLanDescriptor(vector.descriptor);
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error("literal_descriptor_invalid");
    expect(encodeLanDescriptor(descriptor)).toBe(vector.descriptor);
    expect(
      decodeLanDescriptor(vector.descriptor.replace('"port":8517', '"port":08517')),
    ).toBeUndefined();

    const append = {
      purpose: "carrier" as const,
      path: LAN_CARRIER_PATH,
      method: "append" as const,
      vault: "a".repeat(32),
      device: "b".repeat(32),
      writer: "b".repeat(32),
      seg: 7,
      offset: 4096,
      bytesDigest: lanBytesDigest(new TextEncoder().encode("opaque append")),
      nonce: "c".repeat(64),
      expiresAt: 1_800_000_030_000,
    } as const;
    const resume = {
      purpose: "resume" as const,
      path: LAN_PAIR_RESUME_PATH,
      method: "resume" as const,
      vault: "a".repeat(32),
      device: "b".repeat(32),
      session: "d".repeat(32),
      nonce: "e".repeat(64),
      expiresAt: 1_800_000_040_000,
    } as const;
    for (const [input, fixed] of [
      [append, vector.append],
      [resume, vector.resume],
    ] as const) {
      const body = lanAuthBody(input);
      const signature = Buffer.from(fixed.signature, "hex");
      expect(Buffer.from(body)).toEqual(Buffer.from(fixed.bodyUtf8, "utf8"));
      expect(Buffer.from(identity.sign("cashu/lan-auth/v1", body))).toEqual(signature);
      expect(crypto.verifyContextSignature("cashu/lan-auth/v1", body, signature, publicKey)).toBe(
        true,
      );
      expect(crypto.verifyContextSignature("cashu/pairing/v1", body, signature, publicKey)).toBe(
        false,
      );
    }
    const appendSignature = Buffer.from(vector.append.signature, "hex");
    for (const changed of [
      { ...append, purpose: "resume" as const },
      { ...append, path: LAN_PAIR_RESUME_PATH },
      { ...append, method: "read" as const },
      { ...append, vault: "f".repeat(32) },
      { ...append, device: "f".repeat(32) },
      { ...append, writer: "f".repeat(32) },
      { ...append, seg: 8 },
      { ...append, offset: 4097 },
      { ...append, bytesDigest: "f".repeat(64) },
      { ...append, session: "d".repeat(32) },
      { ...append, nonce: "f".repeat(64) },
      { ...append, expiresAt: append.expiresAt + 1 },
    ] as const)
      expect(
        crypto.verifyContextSignature(
          "cashu/lan-auth/v1",
          lanAuthBody(changed),
          appendSignature,
          publicKey,
        ),
      ).toBe(false);
    const resumeSignature = Buffer.from(vector.resume.signature, "hex");
    for (const changed of [
      { ...resume, purpose: "carrier" as const },
      { ...resume, path: LAN_CARRIER_PATH },
      { ...resume, method: "append" as const },
      { ...resume, session: "f".repeat(32) },
      { ...resume, nonce: "f".repeat(64) },
      { ...resume, expiresAt: resume.expiresAt + 1 },
    ] as const)
      expect(
        crypto.verifyContextSignature(
          "cashu/lan-auth/v1",
          lanAuthBody(changed),
          resumeSignature,
          publicKey,
        ),
      ).toBe(false);
  } finally {
    identity.wipe();
  }
});
