import { z } from "zod";

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const MAX_LOCATOR_BYTES = 256 * 1024;
export const MAX_FILES = 100_000;
export const MAX_DEPTH = 8;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024 * 1024;
export const ID = /^[0-9a-f]{32}$/;
export const SHA = /^[0-9a-f]{64}$/;

const ref = z.strictObject({
  sha256: z.string().regex(SHA),
  ext: z.enum(["chk", "manifest"]),
});
const base64 = z
  .string()
  .min(100)
  .max(64 * 1024)
  .regex(/^[A-Za-z0-9_-]+$/);

export const locatorSchema = z.strictObject({
  format: z.literal(1),
  vault: z.string().regex(ID),
  device: z.string().regex(ID),
  manifest: ref,
  baseWrap: base64,
  currentWraps: z.array(base64).min(1).max(1024),
  certificates: z.array(base64).min(1).max(64),
});

export const manifestSchema = z.strictObject({
  format: z.literal(1),
  vault: z.string().regex(ID),
  device: z.string().regex(ID),
  frontier: z
    .string()
    .min(1)
    .max(1024 * 1024),
  key: z.string().regex(ID),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024),
        size: z.number().int().nonnegative().max(MAX_TOTAL_BYTES),
        sha256: z.string().regex(SHA),
        chunks: z.array(ref).max(32768),
      }),
    )
    .min(4)
    .max(MAX_FILES),
});

export type Ref = z.infer<typeof ref>;
export type Locator = z.infer<typeof locatorSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type FileEntry = Manifest["files"][number];

export function parseLocator(value: unknown): Locator {
  const parsed = locatorSchema.safeParse(value);
  if (!parsed.success) throw new Error("native_checkpoint_unavailable");
  return parsed.data;
}
export function parseManifest(value: unknown): Manifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("native_checkpoint_unavailable");
  return parsed.data;
}
