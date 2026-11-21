// The durable intent proof of a device revocation: the fingerprint stored with its keyed attempt,
// read back on reopen and inspection to decide whether the exact batch and rotated key landed.
import { z } from "zod";

/** Attempt journal command id of a device revocation. */
export const REVOKE_COMMAND = "native.devices.revokeCommit";

const HEX_DIGEST = /^[0-9a-f]{64}$/;

// `int()` accepts safe integers only (zod 4), the same set as `Number.isSafeInteger`. Unknown keys
// are ignored, as the attempt fingerprint may carry more than the proof needs.
const revokeIntentProofSchema = z.object({
  preview: z.string().regex(HEX_DIGEST),
  digest: z.string().regex(HEX_DIGEST),
  key: z.object({
    kid: z.string(),
    generation: z.number().int(),
    epoch: z.number().int(),
  }),
});

export interface RevokeIntentProof {
  readonly preview: string;
  readonly digest: string;
  readonly key: { readonly kid: string; readonly generation: number; readonly epoch: number };
}

/**
 * Parses a stored revocation fingerprint. Malformed JSON throws the parser's own SyntaxError; well
 * formed JSON of the wrong shape throws `corrupt_revoke_intent`.
 */
export function parseRevokeIntentProof(value: string): RevokeIntentProof {
  const raw: unknown = JSON.parse(value);
  const parsed = revokeIntentProofSchema.safeParse(raw);
  if (!parsed.success) throw new Error("corrupt_revoke_intent");
  return parsed.data;
}
