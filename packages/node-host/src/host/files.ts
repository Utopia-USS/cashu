// The host's small files in `<run>/`: the token and host.json, written to a temp file (0600) and
// renamed over the target, so a reader sees the old file or the new one, never half of one.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { discoverySchema, formatToken, type HostDiscovery, parseToken } from "@cashu/host-protocol";

function writePrivateFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flush: true });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export const writeHostToken = (path: string, token: Uint8Array) =>
  writePrivateFileAtomic(path, formatToken(token));

/** The current host's token, or undefined when there is none (no host ran, or it was removed). */
export function readHostToken(path: string): Uint8Array | undefined {
  const text = readIfExists(path);
  return text === undefined ? undefined : parseToken(text);
}

export const writeDiscovery = (path: string, discovery: HostDiscovery) =>
  writePrivateFileAtomic(path, `${JSON.stringify(discovery, null, 2)}\n`);

/** host.json, or undefined when missing or not readable as one. */
export function readDiscovery(path: string): HostDiscovery | undefined {
  const text = readIfExists(path);
  if (text === undefined) return undefined;
  try {
    const parsed = discoverySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
