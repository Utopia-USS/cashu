// Folder transport (S28c): a vault log in a directory that iCloud Drive, Syncthing or any file-sync
// tool replicates between devices. Layout `<vault>/<device>/<seq>.seg` (names.ts).
//
// Sync-tool semantics it is built for: eventual (files arrive late and in any order), a file may be
// seen half-downloaded or as an older version, tools create conflict copies, iCloud evicts files to
// placeholders. Guarantees:
// - Conflict free by construction: a device writes only its own directory (`owner`).
// - No in-place rewrites: an append writes the whole new version to a temporary dot-file, flushes it
//   and renames it over the segment (atomic), so neither a sync tool nor a crash ever sees a torn
//   append in the writer's own file. Readers may still see partial files from the tool's side; the
//   engine reads only complete frames and waits for the rest.
// - Conflict copies are versions of the same append-only file: when every version is a prefix of the
//   longest, the segment is the longest one (and the writer deletes the redundant copies on its next
//   append). When two versions diverge (a cloned or reinstalled device id), only their common prefix
//   is shown and `status` reports a fork; the writer refuses to append to a forked segment.
// - Evicted placeholders are reported, not read (downloading them needs the platform, risk R7).
import type { DeviceId, SegmentInfo, Transport, VaultId } from "../../carrier.js";
import { VAULT_RE } from "../../engine.js";
import { TransportError } from "../../errors.js";
import { DEVICE_RE } from "../../hlc.js";
import { concatBytes } from "../../segment.js";
import type { FolderEntry, FolderFs } from "./fs.js";
import { parseSegmentName, segmentFileName, tempFileName } from "./names.js";

export interface FolderTransportOptions {
  readonly fs: FolderFs;
  /** The device this handle belongs to: appends for any other device are refused. */
  readonly owner?: DeviceId;
}

export interface FolderStatus {
  /** Segments that currently have conflict copies next to them (resolved as one segment). */
  readonly conflictCopies: readonly { readonly device: DeviceId; readonly seg: number }[];
  /** Segments whose versions diverge: only the common prefix is readable. */
  readonly forks: readonly { readonly device: DeviceId; readonly seg: number }[];
  /** Segments present only as an iCloud placeholder (not downloaded on this machine). */
  readonly evicted: readonly { readonly device: DeviceId; readonly seg: number }[];
}

interface Version {
  readonly name: string;
  readonly size: number;
}

interface Resolved {
  readonly size: number;
  /** File holding the segment's bytes (absent for a fork, whose bytes are the common prefix). */
  readonly source?: string;
  readonly prefix?: Uint8Array;
  readonly fork: boolean;
  /** Every version name, for cleanup. */
  readonly names: readonly string[];
}

interface DeviceScan {
  readonly versions: Map<number, Version[]>;
  readonly evicted: Set<number>;
  readonly temps: Map<number, string[]>;
}

const EMPTY = new Uint8Array(0);
let tokenCounter = 0;

function token(): string {
  tokenCounter = (tokenCounter + 1) % 1_000_000;
  const rand = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return `${Date.now().toString(36)}${tokenCounter.toString(36)}${rand}`;
}

function checkIds(vault: VaultId, device?: DeviceId, seg?: number): void {
  if (!VAULT_RE.test(vault)) throw new RangeError("invalid vault id");
  if (device !== undefined && !DEVICE_RE.test(device)) throw new RangeError("invalid device id");
  if (seg !== undefined && (!Number.isSafeInteger(seg) || seg < 0)) {
    throw new RangeError("invalid segment number");
  }
}

function scanDevice(entries: readonly FolderEntry[]): DeviceScan {
  const versions = new Map<number, Version[]>();
  const evicted = new Set<number>();
  const temps = new Map<number, string[]>();
  for (const e of entries) {
    if (e.kind !== "file") continue;
    const parsed = parseSegmentName(e.name);
    if (!parsed) continue;
    if (parsed.kind === "evicted") {
      evicted.add(parsed.seg);
    } else if (parsed.kind === "temp") {
      temps.set(parsed.seg, [...(temps.get(parsed.seg) ?? []), e.name]);
    } else {
      versions.set(parsed.seg, [
        ...(versions.get(parsed.seg) ?? []),
        { name: e.name, size: e.size },
      ]);
    }
  }
  return { versions, evicted, temps };
}

function commonPrefix(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export class FolderTransport implements Transport {
  readonly watch?: (vault: VaultId, onChange: () => void) => () => void;
  readonly #fs: FolderFs;
  readonly #owner: DeviceId | undefined;
  /** Merge results of multi-version segments, keyed by path, valid while names and sizes match. */
  readonly #merged = new Map<string, { signature: string; resolved: Resolved }>();
  #status: FolderStatus = { conflictCopies: [], forks: [], evicted: [] };

  constructor(options: FolderTransportOptions) {
    this.#fs = options.fs;
    if (options.owner !== undefined && !DEVICE_RE.test(options.owner)) {
      throw new RangeError("invalid owner device id");
    }
    this.#owner = options.owner;
    const fsWatch = options.fs.watch?.bind(options.fs);
    if (fsWatch) {
      this.watch = (vault, onChange) => {
        checkIds(vault);
        return fsWatch(vault, onChange);
      };
    }
  }

  async list(vault: VaultId): Promise<readonly SegmentInfo[]> {
    checkIds(vault);
    const out: SegmentInfo[] = [];
    const conflictCopies: { device: DeviceId; seg: number }[] = [];
    const forks: { device: DeviceId; seg: number }[] = [];
    const evicted: { device: DeviceId; seg: number }[] = [];
    for (const dir of (await this.#fs.list(vault)) ?? []) {
      if (dir.kind !== "dir" || !DEVICE_RE.test(dir.name)) continue;
      const device = dir.name;
      const scan = scanDevice((await this.#fs.list(`${vault}/${device}`)) ?? []);
      for (const [seg, versions] of scan.versions) {
        const resolved = await this.#resolve(vault, device, seg, versions);
        if (versions.length > 1) conflictCopies.push({ device, seg });
        if (resolved.fork) forks.push({ device, seg });
        out.push({ device, seg, size: resolved.size });
      }
      for (const seg of scan.evicted) {
        if (!scan.versions.has(seg)) evicted.push({ device, seg });
      }
    }
    this.#status = { conflictCopies, forks, evicted };
    return out;
  }

  async read(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    fromOffset: number,
  ): Promise<Uint8Array> {
    checkIds(vault, device, seg);
    const versions = (await this.#scan(vault, device)).versions.get(seg);
    if (!versions) return EMPTY;
    const resolved = await this.#resolve(vault, device, seg, versions);
    const from = Math.max(0, fromOffset);
    if (resolved.fork || !resolved.source) return (resolved.prefix ?? EMPTY).slice(from);
    return (await this.#fs.read(`${vault}/${device}/${resolved.source}`, from)) ?? EMPTY;
  }

  async append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    atOffset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    checkIds(vault, device, seg);
    if (this.#owner !== undefined && device !== this.#owner) {
      throw new RangeError("a folder handle writes only its owner's directory");
    }
    const dir = `${vault}/${device}`;
    const scan = await this.#scan(vault, device);
    const versions = scan.versions.get(seg) ?? [];
    const resolved =
      versions.length > 0 ? await this.#resolve(vault, device, seg, versions) : undefined;
    if (resolved?.fork) {
      throw new TransportError("offset-conflict", "the segment has diverging versions");
    }
    const size = resolved?.size ?? 0;
    if (atOffset !== size) {
      throw new TransportError("offset-conflict", "append offset is not the segment size");
    }
    if (bytes.length === 0) return;
    let existing: Uint8Array = EMPTY;
    if (resolved?.source && size > 0) {
      existing = (await this.#fs.read(`${dir}/${resolved.source}`, 0)) ?? EMPTY;
      if (existing.length !== size) {
        throw new TransportError("offset-conflict", "the segment changed during the append");
      }
    }
    const canonical = segmentFileName(seg);
    const temp = `${dir}/${tempFileName(seg, token())}`;
    try {
      await this.#fs.write(temp, concatBytes([existing, bytes]));
      await this.#fs.rename(temp, `${dir}/${canonical}`);
    } catch (e) {
      await this.#fs.remove(temp).catch(() => undefined);
      throw e;
    }
    this.#merged.delete(`${dir}/${seg}`);
    // Every other version was a prefix of what we just wrote: redundant now. Leftover temp files of
    // this segment come from a crash between write and rename.
    const stale = [
      ...(resolved?.names ?? []).filter((n) => n !== canonical),
      ...(scan.temps.get(seg) ?? []),
    ];
    for (const name of stale) await this.#fs.remove(`${dir}/${name}`);
  }

  /** What the last `list` found besides plain segments. */
  status(): FolderStatus {
    return this.#status;
  }

  // -------------------------------------------------------------------------------------------

  async #scan(vault: VaultId, device: DeviceId): Promise<DeviceScan> {
    return scanDevice((await this.#fs.list(`${vault}/${device}`)) ?? []);
  }

  async #resolve(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    versions: readonly Version[],
  ): Promise<Resolved> {
    const names = versions.map((v) => v.name);
    const only = versions.length === 1 ? versions[0] : undefined;
    if (only) return { size: only.size, source: only.name, fork: false, names };
    const path = `${vault}/${device}/${seg}`;
    const signature = versions
      .map((v) => `${v.name}\u0000${v.size}`)
      .sort()
      .join("\u0001");
    const cached = this.#merged.get(path);
    if (cached?.signature === signature) return cached.resolved;
    const contents = await Promise.all(
      versions.map(async (v) => ({
        name: v.name,
        bytes: (await this.#fs.read(`${vault}/${device}/${v.name}`, 0)) ?? EMPTY,
      })),
    );
    const canonical = segmentFileName(seg);
    contents.sort(
      (a, b) =>
        b.bytes.length - a.bytes.length ||
        Number(b.name === canonical) - Number(a.name === canonical),
    );
    const [longest, ...rest] = contents;
    if (!longest) return { size: 0, fork: false, names };
    let common = longest.bytes.length;
    let fork = false;
    for (const c of rest) {
      const p = commonPrefix(longest.bytes, c.bytes);
      if (p < c.bytes.length) fork = true;
      common = Math.min(common, p);
    }
    const resolved: Resolved = fork
      ? { size: common, prefix: longest.bytes.slice(0, common), fork, names }
      : { size: longest.bytes.length, source: longest.name, fork, names };
    this.#merged.set(path, { signature, resolved });
    return resolved;
  }
}
