// The lab keys file (S26 spec 6.1, impl notes change 1): created 0600, read back, never overwritten.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initKeys, KeysFileError, readKeys } from "./keys.ts";
import { tempDir } from "./testing/pythonDataDir.ts";

describe("genesis keys file", () => {
  it("creates a 0600 format 1 file with a 32-hex vault id and a 64-hex salt per slug", () => {
    const path = join(tempDir("keys"), "keys.json");
    const minted = initKeys(path, ["olek", "ala"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.format).toBe(1);
    expect(Object.keys(file.vaults)).toEqual(["ala", "olek"]);
    for (const k of Object.values<{ vault: string; salt: string }>(file.vaults)) {
      expect(k.vault).toMatch(/^[0-9a-f]{32}$/);
      expect(k.salt).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(file.vaults.ala.vault).not.toBe(file.vaults.olek.vault);
    const read = readKeys(path);
    expect([...read.keys()]).toEqual(["ala", "olek"]);
    for (const [slug, k] of read) {
      expect(k.vault).toBe(minted.get(slug)?.vault);
      expect(Buffer.from(k.salt.bytes).toString("hex")).toBe(file.vaults[slug].salt);
    }
  });

  it("never overwrites an existing file", () => {
    const path = join(tempDir("keys"), "keys.json");
    writeFileSync(path, "{}");
    expect(() => initKeys(path, ["ala"])).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

  it("refuses invalid files without quoting their content", () => {
    const dir = tempDir("keys");
    const cases = {
      "broken.json": "{not json",
      "format.json": JSON.stringify({ format: 2, vaults: {} }),
      "short.json": JSON.stringify({
        format: 1,
        vaults: { ala: { vault: "ab", salt: "0".repeat(64) } },
      }),
      "extra.json": JSON.stringify({
        format: 1,
        vaults: { ala: { vault: "1".repeat(32), salt: "2".repeat(64), note: "x" } },
      }),
    };
    for (const [name, text] of Object.entries(cases)) {
      writeFileSync(join(dir, name), text);
      let error: unknown;
      try {
        readKeys(join(dir, name));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(KeysFileError);
      expect((error as Error).message).not.toMatch(/ala|abab|1111|2222/);
    }
  });
});
