import "reflect-metadata";
import { createHash, randomBytes, webcrypto, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LanDescriptor } from "@cashu/host-protocol/pairing-lan";
import { encodeLanDescriptor } from "@cashu/host-protocol/pairing-lan";
import {
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  IP,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

const KEY_FILE = "lan-tls-key.pk8";
const PIN_FILE = "lan-tls-pin.json";
const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

function pem(label: string, bytes: Uint8Array): string {
  const base64 =
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function derFromPem(value: string): Uint8Array {
  const match =
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/.exec(value);
  if (!match) throw new Error("lan_tls_key_invalid");
  return Buffer.from(match[1]!.replace(/\s/g, ""), "base64");
}

async function readPrivateText(path: string, code: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(code);
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(code);
    return await file.readFile({ encoding: "utf8" });
  } finally {
    await file.close();
  }
}

async function keyBytes(dataDir: string): Promise<Uint8Array> {
  const path = join(dataDir, KEY_FILE);
  const parent = await lstat(dataDir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0)
    throw new Error("lan_tls_dir_invalid");
  try {
    return derFromPem(await readPrivateText(path, "lan_tls_key_invalid"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await lstat(join(dataDir, PIN_FILE));
    throw new Error("lan_tls_key_missing");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const generated = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(pem("PRIVATE KEY", generated));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    await unlink(temporary);
    const directory = await open(dataDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return keyBytes(dataDir);
    throw error;
  }
  return generated;
}

export interface LanTlsIdentity {
  readonly key: string;
  readonly cert: string;
  readonly spki: string;
  descriptor(port: number): LanDescriptor;
}

/** The per-install transport key is host private; certificate renewals retain its SPKI pin. */
export async function loadLanTlsIdentity(
  dataDir: string,
  ip: string,
  now = Date.now(),
): Promise<LanTlsIdentity> {
  // The descriptor validator also rules out DNS, public addresses and alternate IPv4 spellings.
  encodeLanDescriptor({ v: 1, ip, port: 1, spki: "0".repeat(64) }, ip === "127.0.0.1");
  const privateDer = await keyBytes(dataDir);
  const privateKey = await webcrypto.subtle.importKey("pkcs8", privateDer, ALGORITHM, true, [
    "sign",
  ]);
  const nodeKey = (await import("node:crypto")).createPrivateKey({
    key: Buffer.from(privateDer),
    format: "der",
    type: "pkcs8",
  });
  const publicDer = (await import("node:crypto"))
    .createPublicKey(nodeKey)
    .export({ format: "der", type: "spki" });
  const publicKey = await webcrypto.subtle.importKey("spki", publicDer, ALGORITHM, true, [
    "verify",
  ]);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: "CN=cashU LAN host",
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 30 * 24 * 60 * 60 * 1000),
    signingAlgorithm: ALGORITHM,
    keys: { privateKey, publicKey },
    extensions: [
      new SubjectAlternativeNameExtension([{ type: IP, value: ip }], true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
    ],
  });
  const certPem = cert.toString("pem");
  const parsed = new X509Certificate(certPem);
  if (parsed.checkIP(ip) !== ip) throw new Error("lan_tls_san_invalid");
  const spki = createHash("sha256").update(publicDer).digest("hex");
  const marker = join(dataDir, PIN_FILE);
  try {
    const raw = await readPrivateText(marker, "lan_tls_pin_invalid");
    if (raw !== JSON.stringify({ v: 1, spki })) throw new Error("lan_tls_pin_mismatch");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const file = await open(marker, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ v: 1, spki }));
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(dataDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  return {
    key: pem("PRIVATE KEY", privateDer),
    cert: certPem,
    spki,
    descriptor(port) {
      return { v: 1, ip, port, spki };
    },
  };
}
