// The sync relay's Firebase web config, inlined by Metro at bundle time from `EXPO_PUBLIC_FIREBASE_CONFIG`
// (a JSON object; the lead's local `.env.local`, never in git). Absent or not decodable: undefined, and
// every relay surface stays off (the phone syncs nothing remote; pairing says sync is not set up). The
// values are public client identifiers, still never logged: a parse failure reports no value.
import { z } from "zod";

const relayConfigSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9-]{4,40}$/u),
  apiKey: z.string().min(1).max(200),
  appId: z.string().min(1).max(200),
  authDomain: z.string().min(1).max(200),
});

export type RelayConfig = z.infer<typeof relayConfigSchema>;

/** Decode one raw config string; undefined when it is missing, not JSON or not the expected shape. */
export function parseRelayConfig(raw: string | undefined): RelayConfig | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed = relayConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

let cached: { readonly value: RelayConfig | undefined } | undefined;

/** This build's relay config (read once per launch). */
export function relayConfig(): RelayConfig | undefined {
  // The literal `process.env.EXPO_PUBLIC_*` member is what Metro replaces at bundle time.
  cached ??= { value: parseRelayConfig(process.env.EXPO_PUBLIC_FIREBASE_CONFIG) };
  return cached.value;
}
