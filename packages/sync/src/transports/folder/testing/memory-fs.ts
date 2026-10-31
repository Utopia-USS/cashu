// An in-memory `FolderFs` for tests and simulations: files in a map, directories implied by paths,
// watchers by path prefix. Test hooks change a file the way a sync tool or a broken disk would.
import { TransportError } from "../../../errors.js";
import type { FolderEntry, FolderFs } from "../fs.js";

export class MemoryFolderFs implements FolderFs {
  readonly #files = new Map<string, Uint8Array>();
  readonly #watchers = new Set<{ prefix: string; onChange: () => void }>();
  #online = true;

  async list(path: string): Promise<readonly FolderEntry[] | undefined> {
    this.#check();
    const prefix = path === "" ? "" : `${path}/`;
    const entries = new Map<string, FolderEntry>();
    for (const [p, bytes] of this.#files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, { name: rest, kind: "file", size: bytes.length });
      else {
        const name = rest.slice(0, slash);
        if (!entries.has(name)) entries.set(name, { name, kind: "dir", size: 0 });
      }
    }
    return entries.size === 0 ? undefined : [...entries.values()];
  }

  async read(path: string, offset: number): Promise<Uint8Array | undefined> {
    this.#check();
    return this.#files.get(path)?.slice(offset);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.#check();
    this.#files.set(path, bytes.slice());
    this.#notify(path);
  }

  async rename(from: string, to: string): Promise<void> {
    this.#check();
    const bytes = this.#files.get(from);
    if (!bytes) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    this.#files.delete(from);
    this.#files.set(to, bytes);
    this.#notify(to);
  }

  async remove(path: string): Promise<void> {
    this.#check();
    if (this.#files.delete(path)) this.#notify(path);
  }

  watch(path: string, onChange: () => void): () => void {
    const w = { prefix: path === "" ? "" : `${path}/`, onChange };
    this.#watchers.add(w);
    return () => {
      this.#watchers.delete(w);
    };
  }

  // Test hooks -------------------------------------------------------------------------------

  /** Simulate an unmounted folder: every call rejects. */
  setOnline(online: boolean): void {
    this.#online = online;
  }

  /** Every file path (sorted). */
  paths(): string[] {
    return [...this.#files.keys()].sort();
  }

  get(path: string): Uint8Array | undefined {
    return this.#files.get(path)?.slice();
  }

  /** Place bytes at a path directly (a sync tool writing a file, possibly non-atomically). */
  put(path: string, bytes: Uint8Array): void {
    this.#files.set(path, bytes.slice());
    this.#notify(path);
  }

  truncate(path: string, size: number): void {
    const bytes = this.#files.get(path);
    if (bytes) this.put(path, bytes.slice(0, size));
  }

  /** Flip every bit of one byte. */
  flip(path: string, offset: number): void {
    const bytes = this.#files.get(path);
    if (!bytes || offset >= bytes.length) return;
    const copy = bytes.slice();
    copy[offset] = (copy[offset] ?? 0) ^ 0xff;
    this.put(path, copy);
  }

  delete(path: string): void {
    this.#files.delete(path);
  }

  #check(): void {
    if (!this.#online) throw new TransportError("unavailable", "folder offline (test)");
  }

  #notify(path: string): void {
    for (const w of this.#watchers) {
      if (path.startsWith(w.prefix)) queueMicrotask(w.onChange);
    }
  }
}
