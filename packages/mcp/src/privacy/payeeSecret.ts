/**
 * The per-installation payee key (`names._secret`): `<data dir>/mcp/payee.key`, 32 random bytes made
 * on first use (private dirs 0700, file 0600, written through a temp file and renamed). A shorter or
 * unreadable file is replaced. The data dir comes from the caller (the app's paths).
 */

/// <reference types="node" />
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function ensurePrivateDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
}

export function loadPayeeSecret(dataDir: string): Uint8Array {
  const dir = join(dataDir, "mcp");
  const path = join(dir, "payee.key");
  try {
    const data = readFileSync(path);
    if (data.length >= 32) return new Uint8Array(data);
  } catch {
    // missing or unreadable: make a new key below
  }
  ensurePrivateDir(dataDir);
  ensurePrivateDir(dir);
  const data = randomBytes(32);
  const tmp = join(dir, ".payee.key.tmp");
  writeFileSync(tmp, data);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return new Uint8Array(data);
}
