// A Node `fs` implementation of `FolderFs` for tests on a real disk (temp directories). The desktop
// app wires its own adapter at its root (layers.md: the file system belongs to the app); this one
// follows the same port contract: fsync before rename, `TransportError("unavailable")` when the root
// is gone.
import { watch as fsWatch, mkdirSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TransportError } from "../../../errors.js";
import type { FolderEntry, FolderFs } from "../fs.js";

function code(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

export class NodeFolderFs implements FolderFs {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  #abs(path: string): string {
    if (path.split("/").some((part) => part === ".."))
      throw new RangeError("path escapes the root");
    return path === "" ? this.root : join(this.root, ...path.split("/"));
  }

  async #checkRoot(): Promise<void> {
    try {
      await stat(this.root);
    } catch {
      throw new TransportError("unavailable", "the synced folder is not reachable", "outage");
    }
  }

  async list(path: string): Promise<readonly FolderEntry[] | undefined> {
    await this.#checkRoot();
    const dir = this.#abs(path);
    let names: { name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (code(e) === "ENOENT" || code(e) === "ENOTDIR") return undefined;
      throw e;
    }
    const out: FolderEntry[] = [];
    for (const d of names) {
      if (d.isDirectory()) out.push({ name: d.name, kind: "dir", size: 0 });
      else if (d.isFile()) {
        try {
          out.push({ name: d.name, kind: "file", size: (await stat(join(dir, d.name))).size });
        } catch (e) {
          if (code(e) !== "ENOENT") throw e; // renamed or removed meanwhile
        }
      }
    }
    return out;
  }

  async read(path: string, offset: number): Promise<Uint8Array | undefined> {
    await this.#checkRoot();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.#abs(path), "r");
    } catch (e) {
      if (code(e) === "ENOENT") return undefined;
      throw e;
    }
    try {
      const { size } = await handle.stat();
      if (offset >= size) return new Uint8Array(0);
      const buf = new Uint8Array(size - offset);
      let filled = 0;
      while (filled < buf.length) {
        const { bytesRead } = await handle.read(buf, filled, buf.length - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buf.subarray(0, filled);
    } finally {
      await handle.close();
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.#checkRoot();
    const abs = this.#abs(path);
    await mkdir(dirname(abs), { recursive: true });
    const handle = await open(abs, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.#checkRoot();
    await rename(this.#abs(from), this.#abs(to));
  }

  async remove(path: string): Promise<void> {
    await this.#checkRoot();
    await rm(this.#abs(path), { force: true });
  }

  watch(path: string, onChange: () => void): () => void {
    const abs = this.#abs(path);
    mkdirSync(abs, { recursive: true });
    const watcher = fsWatch(abs, { recursive: true }, () => onChange());
    return () => watcher.close();
  }
}
