import { z } from "zod";

export const NATIVE_BANKING_FEATURE = "native.banking.v1";
export const NATIVE_BANKING_METHODS = [
  "native.banking.configure",
  "native.banking.consentUrl",
] as const;
export const bankingConfigureParamsSchema = z.strictObject({
  vaultId: z.string().regex(/^[0-9a-f]{32}$/),
  appId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  keyFilePath: z.string().min(1).max(4096),
});
export const bankingConsentUrlParamsSchema = z.strictObject({
  vaultId: z.string().regex(/^[0-9a-f]{32}$/),
  url: z.url().refine((value) => value.startsWith("https://")),
});
export const bankingNativeResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("configured") }),
  z.strictObject({ kind: z.literal("allowed") }),
  z.strictObject({ kind: z.literal("outcome_unknown") }),
  z.strictObject({
    kind: z.literal("refused"),
    code: z.enum([
      "unavailable",
      "invalid_input",
      "authorization",
      "configuration",
      "key_unreadable",
      "key_invalid",
    ]),
  }),
]);
export function uiBankingAllowed(
  method: string,
  minor: number,
  features: readonly string[],
): boolean {
  return (
    minor >= 7 &&
    features.includes(NATIVE_BANKING_FEATURE) &&
    NATIVE_BANKING_METHODS.some((allowed) => method === allowed)
  );
}
