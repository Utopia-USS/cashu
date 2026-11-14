// A deterministic simulation of a file-sync service (iCloud Drive / Syncthing) between device
// replicas of one folder, for multi-device tests. Each device has its own replica (`FolderFs`); the
// service keeps a cloud copy and moves whole files with random delays:
// - uploads: a device's own directory -> cloud (latest content at transfer time, deletions too);
// - downloads: cloud -> every other replica, in random order across files (segment 3 before
//   segment 2, the manifest after the segments), sometimes first as a truncated file (a download in
//   progress, `partialRate`), always eventually complete;
// - conflicts (`conflictRate`): an upload over a changed cloud file keeps both versions, one under a
//   conflict-copy name (` (1)`, ` 2`, `.sync-conflict-...`), and both reach every replica.
// A device's own segment files are never overwritten by downloads (the service knows the local file
// is newer); conflict copies in its directory do arrive. `flush()` turns the chaos off and runs until
// every replica is complete: the "eventually" of eventual consistency.
import type { DeviceId } from "../../../carrier.js";
import type { FolderFs } from "../fs.js";
import { parseSegmentName } from "../names.js";

export interface CloudSimOptions {
  readonly seed: number;
  /** Probability that a download first lands truncated (default 0). */
  readonly partialRate?: number;
  /** Probability that an upload over a changed cloud file creates a conflict copy (default 0). */
  readonly conflictRate?: number;
  /** Largest delay of one transfer in ticks (default 5). */
  readonly maxDelay?: number;
}

interface Replica {
  readonly device: DeviceId;
  readonly fs: FolderFs;
  /** Last content uploaded per own path. */
  readonly uploaded: Map<string, Uint8Array>;
  /** Last content downloaded per path. */
  readonly downloaded: Map<string, Uint8Array>;
  /** Paths the service itself wrote into this replica (partly or fully): never uploaded back. */
  readonly received: Set<string>;
}

interface Transfer {
  readonly at: number;
  readonly order: number;
  readonly key: string;
  readonly run: () => Promise<void>;
}

/** mulberry32: small, seeded, good enough for test schedules. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return a === b;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function walk(fs: FolderFs, path = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await fs.list(path)) ?? []) {
    if (e.name.startsWith(".")) continue;
    const p = path === "" ? e.name : `${path}/${e.name}`;
    if (e.kind === "dir") out.push(...(await walk(fs, p)));
    else out.push(p);
  }
  return out;
}

/** `vault/device/name` -> device. */
function ownerOf(path: string): string | undefined {
  return path.split("/")[1];
}

export class CloudSim {
  readonly cloud = new Map<string, Uint8Array>();
  readonly #replicas = new Map<DeviceId, Replica>();
  readonly #random: () => number;
  readonly #partialRate: number;
  readonly #conflictRate: number;
  readonly #maxDelay: number;
  readonly #pending = new Map<string, Transfer>();
  #now = 0;
  #order = 0;
  #calm = false;
  /** Conflict copies created so far (tests assert the scenario really happened). */
  conflicts = 0;
  /** Truncated downloads delivered so far. */
  partials = 0;

  constructor(options: CloudSimOptions) {
    this.#random = seededRandom(options.seed);
    this.#partialRate = options.partialRate ?? 0;
    this.#conflictRate = options.conflictRate ?? 0;
    this.#maxDelay = Math.max(1, options.maxDelay ?? 5);
  }

  addReplica(device: DeviceId, fs: FolderFs): void {
    if (this.#replicas.has(device)) throw new Error("replica already registered");
    this.#replicas.set(device, {
      device,
      fs,
      uploaded: new Map(),
      downloaded: new Map(),
      received: new Set(),
    });
  }

  replica(device: DeviceId): FolderFs | undefined {
    return this.#replicas.get(device)?.fs;
  }

  get pending(): number {
    return this.#pending.size;
  }

  /** Detect changes on every replica and in the cloud; schedule the transfers they need. */
  async scan(): Promise<void> {
    for (const r of this.#replicas.values()) {
      const files = await walk(r.fs);
      const present = new Set(files);
      for (const p of files) {
        // The owner's own writes go up; conflict copies the service brought down do not.
        if (ownerOf(p) !== r.device || r.received.has(p)) continue;
        const bytes = await r.fs.read(p, 0);
        if (!sameBytes(bytes, r.uploaded.get(p)))
          this.#schedule(`up:${r.device}:${p}`, () => this.#upload(r, p));
      }
      for (const p of r.uploaded.keys()) {
        if (!present.has(p)) this.#schedule(`up:${r.device}:${p}`, () => this.#upload(r, p));
      }
      for (const p of r.received) {
        // The owner deleted a conflict copy it had received: the deletion goes up.
        if (!present.has(p)) this.#schedule(`up:${r.device}:${p}`, () => this.#removeCopy(r, p));
      }
      for (const [p, bytes] of this.cloud) {
        if (ownerOf(p) === r.device) {
          // Into the owner's directory only conflict copies: new ones, or one still downloading.
          const name = p.split("/").at(-1) ?? "";
          if (parseSegmentName(name)?.kind !== "copy") continue;
          const fresh = !r.received.has(p) && !present.has(p);
          const unfinished =
            r.received.has(p) && present.has(p) && !sameBytes(await r.fs.read(p, 0), bytes);
          if (fresh || unfinished) {
            this.#schedule(`down:${r.device}:${p}`, () => this.#download(r, p));
          }
          continue;
        }
        if (!present.has(p) || !sameBytes(await r.fs.read(p, 0), bytes)) {
          this.#schedule(`down:${r.device}:${p}`, () => this.#download(r, p));
        }
      }
      for (const p of files) {
        if (ownerOf(p) !== r.device && !this.cloud.has(p)) {
          this.#schedule(`down:${r.device}:${p}`, () => this.#download(r, p));
        }
      }
    }
  }

  /** Run up to `n` transfers in schedule order. Returns how many ran. */
  async step(n = 1): Promise<number> {
    let ran = 0;
    while (ran < n) {
      const next = [...this.#pending.values()].sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!next) break;
      this.#pending.delete(next.key);
      this.#now = Math.max(this.#now, next.at);
      await next.run();
      ran += 1;
    }
    return ran;
  }

  /** Random progress: scan, then run a random number of transfers (up to `max`). */
  async churn(max = 8): Promise<void> {
    await this.scan();
    await this.step(1 + Math.floor(this.#random() * max));
  }

  /** No more chaos: run every transfer until all replicas hold the complete cloud state. */
  async flush(): Promise<void> {
    this.#calm = true;
    try {
      for (let round = 0; round < 50; round++) {
        await this.scan();
        if (this.#pending.size === 0) return;
        await this.step(Number.POSITIVE_INFINITY);
      }
      throw new Error("cloud simulation did not settle");
    } finally {
      this.#calm = false;
    }
  }

  #schedule(key: string, run: () => Promise<void>): void {
    if (this.#pending.has(key)) return;
    const delay = 1 + Math.floor(this.#random() * this.#maxDelay);
    this.#order += 1;
    // Random tie-break: transfers due at the same tick run in a random order.
    const order = this.#random() * 1e6 + this.#order / 1e6;
    this.#pending.set(key, { at: this.#now + delay, order, key, run });
  }

  async #upload(r: Replica, path: string): Promise<void> {
    const bytes = await r.fs.read(path, 0);
    if (!bytes) {
      this.cloud.delete(path);
      r.uploaded.delete(path);
      return;
    }
    const previous = this.cloud.get(path);
    if (
      !this.#calm &&
      previous &&
      !sameBytes(previous, bytes) &&
      this.#random() < this.#conflictRate
    ) {
      const copy = this.#copyName(path);
      this.conflicts += 1;
      if (this.#random() < 0.5) {
        this.cloud.set(copy, bytes); // the new version lands as the copy, the old one stays
      } else {
        this.cloud.set(copy, previous);
        this.cloud.set(path, bytes);
      }
    } else {
      this.cloud.set(path, bytes);
    }
    r.uploaded.set(path, bytes);
  }

  async #download(r: Replica, path: string): Promise<void> {
    const bytes = this.cloud.get(path);
    if (!bytes) {
      if (ownerOf(path) !== r.device || r.received.has(path)) await r.fs.remove(path);
      r.downloaded.delete(path);
      r.received.delete(path);
      return;
    }
    if (ownerOf(path) === r.device) r.received.add(path);
    if (!this.#calm && bytes.length > 1 && this.#random() < this.#partialRate) {
      this.partials += 1;
      await r.fs.write(path, bytes.slice(0, 1 + Math.floor(this.#random() * (bytes.length - 1))));
      return; // the next scan sees the difference and downloads the rest
    }
    await r.fs.write(path, bytes);
    r.downloaded.set(path, bytes);
  }

  async #removeCopy(r: Replica, path: string): Promise<void> {
    if (!(await r.fs.read(path, 0))) this.cloud.delete(path);
    r.received.delete(path);
  }

  #copyName(path: string): string {
    const slash = path.lastIndexOf("/");
    const dir = path.slice(0, slash);
    const base = path.slice(slash + 1).replace(/\.seg$/, "");
    const styles = [
      (n: number) => `${base} (${n}).seg`,
      (n: number) => `${base} ${n + 1}.seg`,
      (n: number) => `${base}.sync-conflict-20261031-1200${String(n).padStart(2, "0")}-SIMDEV7.seg`,
    ];
    const style = styles[Math.floor(this.#random() * styles.length)] ?? styles[0];
    for (let n = 1; ; n++) {
      const candidate = `${dir}/${style?.(n) ?? `${base} (${n}).seg`}`;
      if (!this.cloud.has(candidate)) return candidate;
    }
  }
}
