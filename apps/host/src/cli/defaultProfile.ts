import type { HostStores } from "../stores.js";

const PROFILE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

/** Resolve one invocation's default from every opened profile, in creation order. */
export function defaultProfileSlug(stores: Pick<HostStores, "vaults">): string | undefined {
  const profiles: { slug: string; createdAt: string }[] = [];
  for (const vault of stores.vaults.values()) {
    const rows = vault.store.read<{ slug: string; createdAt: string }>(
      "SELECT slug, created_at AS createdAt FROM profiles",
    );
    // An incomplete vault must never cause selection of a younger, unrelated profile.
    if (
      rows.length !== 1 ||
      !rows[0]?.slug ||
      typeof rows[0].createdAt !== "string" ||
      !PROFILE_TIME.test(rows[0].createdAt)
    )
      return undefined;
    profiles.push(rows[0]);
  }
  profiles.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return profiles[0]?.createdAt === profiles[1]?.createdAt ? undefined : profiles[0]?.slug;
}
