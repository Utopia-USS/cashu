import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadPayeeSecret } from "./payeeSecret.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("makes a private key when it is missing, then reuses it", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-payee-"));
  roots.push(root);
  const first = loadPayeeSecret(root);
  expect(first).toHaveLength(32);
  const path = join(root, "mcp", "payee.key");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(loadPayeeSecret(root)).toEqual(first);
  expect(new Uint8Array(readFileSync(path))).toEqual(first);
});

it("replaces a key file that is too short", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-payee-"));
  roots.push(root);
  loadPayeeSecret(root);
  const path = join(root, "mcp", "payee.key");
  writeFileSync(path, Buffer.alloc(8, 1));
  const replaced = loadPayeeSecret(root);
  expect(replaced).toHaveLength(32);
  expect(new Uint8Array(readFileSync(path))).toEqual(replaced);
});
