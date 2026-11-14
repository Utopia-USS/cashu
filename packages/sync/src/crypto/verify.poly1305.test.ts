// The tag-only AEAD path (verify.ts) uses @noble/ciphers' internal `_poly1305.js` (no public export
// exists). The version is pinned exactly; this test fails when an upgrade changes the module's
// shape (the `create` / `update` / `digest` API) or its output (RFC 8439 2.5.2 vector).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { poly1305 } from "@noble/ciphers/_poly1305.js";
import { describe, expect, it } from "vitest";

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const KEY = hex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
const MSG = new TextEncoder().encode("Cryptographic Forum Research Group");
const TAG = "a8061dc1305136c6c22b8baf0c0127a9";
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("@noble/ciphers internal Poly1305 (pinned)", () => {
  it("is the pinned version, declared exactly", () => {
    const declared = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(declared.dependencies["@noble/ciphers"]).toBe("2.4.0");
    const installed = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("package.json", import.meta.resolve("@noble/ciphers/_poly1305.js"))),
        "utf8",
      ),
    ) as { version: string };
    expect(installed.version).toBe("2.4.0");
  });

  it("keeps the incremental API and output verify.ts relies on", () => {
    expect(typeof poly1305).toBe("function");
    expect(typeof poly1305.create).toBe("function");
    const mac = poly1305.create(KEY);
    expect(typeof mac.update).toBe("function");
    expect(typeof mac.digest).toBe("function");
    mac.update(MSG.subarray(0, 10));
    mac.update(MSG.subarray(10));
    expect(toHex(mac.digest())).toBe(TAG);
    expect(toHex(poly1305(MSG, KEY))).toBe(TAG);
  });
});
