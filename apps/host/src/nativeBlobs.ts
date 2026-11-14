import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type HostLock, hostRunPaths } from "@cashu/node-host";
import type {
  ImportArchive,
  ImportPublication,
  PublishedImportReceipt,
} from "@cashu/store/investments/services";
import { crypto } from "@cashu/sync";

const REF_SHA = /^[0-9a-f]{64}$/;
const REF_EXT = /^[a-z0-9]{1,10}$/;

function privateDirectory(path: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("native blob directory is unavailable");
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readPrivateFile(path: string, max: number): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const named = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.dev !== named.dev ||
      stat.ino !== named.ino ||
      stat.size !== named.size ||
      stat.size > max
    )
      throw new Error("native blob file is unavailable");
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) throw new Error("native blob file is unavailable");
      offset += n;
    }
    const extra = new Uint8Array(1);
    if (readSync(fd, extra, 0, 1, offset) !== 0) throw new Error("native blob file is unavailable");
    const after = fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size)
      throw new Error("native blob file changed");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** A fixed vault's encrypted content-addressed blobs, shared by ordinary import ports. */
export class NativeBlobPublication implements ImportPublication, ImportArchive {
  readonly vault: string;
  readonly binding = Object.freeze({});
  readonly #dataDir: string;
  readonly #lock: HostLock;
  readonly #sodium: crypto.Sodium;
  readonly #ring: crypto.Keyring;
  #closed = false;

  constructor(input: {
    readonly dataDir: string;
    readonly vault: string;
    readonly lock: HostLock;
    readonly sodium: crypto.Sodium;
    readonly ring: crypto.Keyring;
  }) {
    crypto.assertVaultId(input.vault);
    if (
      input.vault !== input.ring.vaultId ||
      input.lock.path !== hostRunPaths(input.dataDir).lockPath ||
      !input.lock.held
    )
      throw new Error("native blob authority is unavailable");
    this.vault = input.vault;
    this.#dataDir = input.dataDir;
    this.#lock = input.lock;
    this.#sodium = input.sodium;
    this.#ring = input.ring;
    this.#directories(false);
  }

  isCurrent(): boolean {
    return !this.#closed && this.#lock.held;
  }
  close(): void {
    this.#closed = true;
  }

  #directories(createBlob: boolean): string {
    if (!this.isCurrent()) throw new Error("native blob authority is unavailable");
    privateDirectory(this.#dataDir, false);
    const vaults = join(this.#dataDir, "vaults");
    const root = join(vaults, this.vault);
    const blobs = join(root, "blobs");
    privateDirectory(vaults, false);
    privateDirectory(root, false);
    if (createBlob) {
      privateDirectory(blobs, true);
      syncDirectory(root);
    } else {
      try {
        privateDirectory(blobs, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return blobs;
  }

  #path(ref: { readonly sha256: string; readonly ext: string }, create: boolean): string {
    if (!REF_SHA.test(ref.sha256) || !REF_EXT.test(ref.ext))
      throw new Error("invalid native blob reference");
    return join(this.#directories(create), `${ref.sha256}.${ref.ext}.enc`);
  }

  async publish(
    content: Uint8Array,
    expected: Readonly<{ readonly sha256: string; readonly ext: string }>,
  ): Promise<PublishedImportReceipt> {
    const path = this.#path(expected, true);
    const digest = createHash("sha256").update(content).digest("hex");
    if (
      digest !== expected.sha256 ||
      content.length === 0 ||
      content.length > crypto.MAX_BLOB_PLAINTEXT
    )
      throw new Error("invalid native blob content");
    const existing = readPrivateFile(path, crypto.blobSize(crypto.MAX_BLOB_PLAINTEXT));
    if (existing !== null) {
      const plain = crypto.openBlob(this.#sodium, this.#ring, this.vault, expected, existing);
      try {
        if (plain.length !== content.length || plain.some((byte, index) => byte !== content[index]))
          throw new Error("native blob content changed");
      } finally {
        plain.fill(0);
      }
      return { blob: { ...expected }, privateStage: null };
    }
    const sealed = crypto.sealBlob(this.#sodium, this.#ring, this.vault, expected, content);
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < sealed.length) {
        const n = writeSync(fd, sealed, offset, sealed.length - offset);
        if (n <= 0) throw new Error("native blob write failed");
        offset += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(dirname(path));
    if (!this.isCurrent()) throw new Error("native blob authority is unavailable");
    return { blob: { ...expected }, privateStage: null };
  }

  async put(
    content: Uint8Array,
    ext: string,
  ): Promise<{ readonly sha256: string; readonly ext: string }> {
    const fixed = Uint8Array.from(content);
    const ref = { sha256: createHash("sha256").update(fixed).digest("hex"), ext };
    try {
      const receipt = await this.publish(fixed, ref);
      const readback = await this.read(this.vault, ref, fixed.length);
      try {
        if (
          !readback ||
          readback.length !== fixed.length ||
          readback.some((byte, index) => byte !== fixed[index])
        )
          throw new Error("native blob readback failed");
      } finally {
        readback?.fill(0);
      }
      return receipt.blob;
    } finally {
      fixed.fill(0);
    }
  }

  async read(
    vault: string,
    ref: { readonly sha256: string; readonly ext: string },
    maxBytes: number,
  ): Promise<Uint8Array | null> {
    if (vault !== this.vault || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error("native blob read authority is unavailable");
    const path = this.#path(ref, false);
    const sealed = readPrivateFile(path, crypto.blobSize(crypto.MAX_BLOB_PLAINTEXT));
    if (sealed === null) return null;
    const content = crypto.openBlob(this.#sodium, this.#ring, this.vault, ref, sealed);
    if (content.length > maxBytes) {
      content.fill(0);
      throw new Error("native blob read exceeds limit");
    }
    return content;
  }

  async discardPrivateStage(_receipt: object): Promise<void> {
    throw new Error("native blob publication has no private stage");
  }
}
