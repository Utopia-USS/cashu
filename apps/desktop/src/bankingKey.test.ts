import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptedDroppedKey, bankingAppId } from "./bankingKey.js";

const APP = "2e79b1c2-0000-4000-8000-000000000000";

describe("bankingAppId", () => {
  it("prefers the typed ID and trims it", () => {
    expect(bankingAppId(`  ${APP} `, "/keys/other.pem")).toBe(APP);
  });

  it("falls back to the key file's name, the way Enable Banking saves it", () => {
    expect(bankingAppId("", `/Users/x/Downloads/${APP}.pem`)).toBe(APP);
    expect(bankingAppId("", `/Users/x/Downloads/${APP}.PEM`)).toBe(APP);
  });

  it("is null when neither gives a valid ID", () => {
    expect(bankingAppId("", "/Users/x/Downloads/my key (1).pem")).toBeNull();
    expect(bankingAppId("has space", `/k/${APP}.pem`)).toBeNull();
  });
});

describe("acceptedDroppedKey", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const dir = () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-banking-key-"));
    roots.push(root);
    return root;
  };

  it("accepts an absolute path to a small regular .pem file", () => {
    const path = join(dir(), `${APP}.pem`);
    writeFileSync(path, "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n");
    expect(acceptedDroppedKey(path)).toBe(true);
  });

  it("refuses relative paths, other extensions, empty, huge, missing, directories and symlinks", () => {
    const root = dir();
    const key = join(root, "key.pem");
    writeFileSync(key, "synthetic");
    const text = join(root, "key.txt");
    writeFileSync(text, "synthetic");
    const empty = join(root, "empty.pem");
    writeFileSync(empty, "");
    const huge = join(root, "huge.pem");
    writeFileSync(huge, "x".repeat(64 * 1024 + 1));
    const folder = join(root, "folder.pem");
    mkdirSync(folder);
    const link = join(root, "link.pem");
    symlinkSync(key, link);
    for (const path of ["key.pem", text, empty, huge, join(root, "missing.pem"), folder, link])
      expect(acceptedDroppedKey(path), path).toBe(false);
  });
});
