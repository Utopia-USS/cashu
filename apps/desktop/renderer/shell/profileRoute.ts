export interface OpenProfileIdentity {
  readonly slug: string;
  readonly vault: string;
}

/** A readable slug is not a vault identity. Only an explicit matching open vault resolves duplicates. */
export function resolveProfileRoute<T extends OpenProfileIdentity>(
  profiles: readonly T[],
  slug: string,
  vault?: string,
): { kind: "ready"; profile: T } | { kind: "ambiguous" | "unavailable" } {
  const matching = profiles.filter(
    (profile) => profile.slug === slug && (vault === undefined || profile.vault === vault),
  );
  if (matching.length > 1) return { kind: "ambiguous" };
  const profile = matching[0];
  return profile === undefined ? { kind: "unavailable" } : { kind: "ready", profile };
}
