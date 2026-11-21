/** S22a read prerequisite: derive the legacy allocation-drift generic-bucket flag. */
import { isGenericBucket } from "../../domain/buckets.js";

export function driftBucketGeneric(payload: Readonly<Record<string, unknown>> | null): boolean {
  const flag = payload?.bucket_generic;
  if (typeof flag === "boolean") return flag;
  const bucket = payload?.bucket_id;
  return bucket === null || bucket === undefined || isGenericBucket(bucket);
}

/** Preserve explicit stored flags, including malformed ones, just as the Python read view does. */
export function withBucketGeneric(
  kind: string,
  payload: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> | null {
  if (kind !== "allocation_drift" || payload === null || Object.hasOwn(payload, "bucket_generic"))
    return payload;
  return { ...payload, bucket_generic: driftBucketGeneric(payload) };
}
