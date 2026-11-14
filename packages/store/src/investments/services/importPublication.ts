/** Checked awaited publication, independent of queue/store access and owner approval. */
import { sha256Hex } from "@cashu/domain";
import { MAX_FILE_BYTES } from "@cashu/domain/investments/importing";
import { blobRef } from "../../events/v1/primitives.js";
import { archiveExtension } from "../commands/imports.js";
import type { ProposalImportBlobs } from "./import-proposals.js";
import type { BlobRef } from "./imports.js";

/** Identity belongs to the publisher. No path, content hash or caller-provided receipt is ownership. */
export type OwnedPrivateImportStage = object;
export interface PublishedImportReceipt {
  readonly blob: BlobRef;
  readonly privateStage: OwnedPrivateImportStage | null;
}
export interface ImportPublication extends ProposalImportBlobs {
  readonly vault: string;
  readonly binding: object;
  isCurrent(): boolean;
  publish(content: Uint8Array, expected: Readonly<BlobRef>): Promise<PublishedImportReceipt>;
  /** Idempotent, issuer-checked cleanup of this receipt's private staging only. Never durable blobs. */
  discardPrivateStage(receipt: OwnedPrivateImportStage): Promise<void>;
}
export interface CheckedImportBlob {
  readonly blob: Readonly<BlobRef>;
  readonly cleanupFailed: boolean;
}

/** Durable content-addressed blobs remain for normal GC even if the caller subsequently refuses. */
export async function publishCheckedImportBlob(
  publication: ImportPublication,
  vault: string,
  file: { readonly name: string; readonly content: Uint8Array },
  signal?: AbortSignal,
): Promise<CheckedImportBlob> {
  const current = () => {
    if (signal?.aborted || publication.vault !== vault || !publication.isCurrent())
      throw new Error("import publication authority is unavailable");
  };
  current();
  if (file.content.length === 0 || file.content.length > MAX_FILE_BYTES)
    throw new Error("invalid import publication size");
  const content = Uint8Array.from(file.content);
  const expected = Object.freeze({ sha256: sha256Hex(content), ext: archiveExtension(file.name) });
  let privateStage: OwnedPrivateImportStage | null = null;
  let cleanupFailed = false;
  let published: Readonly<BlobRef>;
  try {
    const receipt = await publication.publish(Uint8Array.from(content), expected);
    // Own receipt facts immediately. The stage identity is opaque and verified by its issuer.
    const stage = receipt.privateStage;
    if (stage !== null && typeof stage !== "object")
      throw new Error("invalid private import stage receipt");
    privateStage = stage;
    const parsed = blobRef.safeParse({ sha256: receipt.blob.sha256, ext: receipt.blob.ext });
    if (!parsed.success) throw new Error("invalid published blob reference");
    published = Object.freeze({ sha256: parsed.data.sha256, ext: parsed.data.ext });
    current();
    if (published.sha256 !== expected.sha256 || published.ext !== expected.ext)
      throw new Error("published import changed");
    const answer = await publication.read(vault, published, MAX_FILE_BYTES);
    current();
    if (answer === null || answer.length > MAX_FILE_BYTES || answer.length !== content.length)
      throw new Error("invalid published import readback");
    const readback = Uint8Array.from(answer);
    if (sha256Hex(readback) !== expected.sha256) throw new Error("published import hash mismatch");
    // Neither a dishonest ref nor a hash implementation collision can substitute the approved bytes.
    if (readback.some((byte, index) => byte !== content[index]))
      throw new Error("published import content mismatch");
  } finally {
    if (privateStage !== null) {
      try {
        await publication.discardPrivateStage(privateStage);
      } catch {
        cleanupFailed = true;
      }
    }
  }
  current();
  return { blob: published, cleanupFailed };
}
