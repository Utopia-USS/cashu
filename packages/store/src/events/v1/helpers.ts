// Small builders shared by the payload schema files.
import { z } from "zod";
import { stamps } from "./primitives.js";

/**
 * A create / record payload: loose object (unknown fields preserved and ignored), plus the optional
 * typed `stamps` (explicit domain timestamps per view column, events.md 4.4).
 */
export function payload<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject({ ...shape, stamps: stamps.optional() });
}

/**
 * A change payload (LWW-F patch, events.md 4.2): every field optional, absent = unchanged,
 * null = clear (where the field schema allows null). At least one known field must be present.
 */
export function patchOf<T extends z.ZodRawShape>(shape: T) {
  return keyedPatch({}, shape);
}

/**
 * A patch that also names its subject (`account`, `instrument`): the `required` fields must be
 * present, and at least one of the `fields` must be set (`stamps` does not count).
 */
export function keyedPatch<R extends z.ZodRawShape, T extends z.ZodRawShape>(
  required: R,
  fields: T,
) {
  const keys = Object.keys(fields);
  return z
    .looseObject({ ...required, ...z.object(fields).partial().shape, stamps: stamps.optional() })
    .refine((value) => keys.some((k) => k in value), {
      message: `a patch must set at least one of: ${keys.join(", ")}`,
    });
}

/** An empty payload (`{}`): deletes, restores, undo, read marks. Unknown fields still pass. */
export const empty = payload({});
