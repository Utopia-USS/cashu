import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadLanTlsIdentity } from "./tls.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("retains one TLS SPKI pin across certificate renewal and binds exact IP SAN", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cashu-lan-tls-"));
  dirs.push(dir);
  const first = await loadLanTlsIdentity(dir, "127.0.0.1", 1_800_000_000_000);
  const second = await loadLanTlsIdentity(dir, "127.0.0.1", 1_800_000_100_000);
  expect(first.spki).toMatch(/^[0-9a-f]{64}$/);
  expect(second.spki).toBe(first.spki);
  expect(second.key).toBe(first.key);
  expect(second.cert).not.toBe(first.cert);
  expect(first.descriptor(44123)).toEqual({ v: 1, ip: "127.0.0.1", port: 44123, spki: first.spki });
  await expect(loadLanTlsIdentity(dir, "8.8.8.8")).rejects.toThrow("lan_descriptor_invalid");
});

it("pins the literal shared synthetic certificate vector", async () => {
  const raw = await readFile(
    join(process.cwd(), "../../packages/host-protocol/spec/lan-pin-vector-v1.json"),
    "utf8",
  );
  const vector = JSON.parse(raw) as {
    ip: string;
    validAt: string;
    expiredAt: string;
    certificatePem: string;
    spkiSha256: string;
  };
  const certificate = new X509Certificate(vector.certificatePem);
  expect(certificate.checkIP(vector.ip)).toBe(vector.ip);
  expect(certificate.checkIP("127.0.0.2")).toBeUndefined();
  expect(
    createHash("sha256")
      .update(certificate.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex"),
  ).toBe(vector.spkiSha256);
  expect(Date.parse(certificate.validFrom)).toBeLessThan(Date.parse(vector.validAt));
  expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.parse(vector.validAt));
  expect(Date.parse(certificate.validTo)).toBeLessThan(Date.parse(vector.expiredAt));
});

it("fails closed when a published pin loses or changes its private key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cashu-lan-tls-loss-"));
  dirs.push(dir);
  const first = await loadLanTlsIdentity(dir, "127.0.0.1");
  await unlink(join(dir, "lan-tls-key.pk8"));
  await expect(loadLanTlsIdentity(dir, "127.0.0.1")).rejects.toThrow("lan_tls_key_missing");
  await writeFile(join(dir, "lan-tls-key.pk8"), first.key, { mode: 0o600 });
  await writeFile(join(dir, "lan-tls-pin.json"), JSON.stringify({ v: 1, spki: "f".repeat(64) }));
  await expect(loadLanTlsIdentity(dir, "127.0.0.1")).rejects.toThrow("lan_tls_pin_mismatch");
});

it("recovers an unpublished key after a crash without rotating or following a symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cashu-lan-tls-crash-"));
  dirs.push(dir);
  const first = await loadLanTlsIdentity(dir, "127.0.0.1");
  await unlink(join(dir, "lan-tls-pin.json"));
  expect((await loadLanTlsIdentity(dir, "127.0.0.1")).spki).toBe(first.spki);
  await unlink(join(dir, "lan-tls-key.pk8"));
  await symlink(join(dir, "lan-tls-pin.json"), join(dir, "lan-tls-key.pk8"));
  await expect(loadLanTlsIdentity(dir, "127.0.0.1")).rejects.toThrow("lan_tls_key_invalid");
});
