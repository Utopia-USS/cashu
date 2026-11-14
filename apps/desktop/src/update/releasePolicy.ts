/**
 * Pinned by the owner-controlled signed release, never read from renderer, env or feed metadata.
 * The package step (scripts/release-policy.mjs) reads these two literals to write the sealed
 * Contents/Resources/app-update.yml, so keep each one a single `string | null` string literal.
 * Updates come from the GitHub Releases of Utopia-USS/cashu: electron-updater's generic provider
 * resolves latest-mac.yml and the zips relative to this base and follows GitHub's redirect.
 */
export const RELEASE_TEAM_ID: string | null = "29W838VKU4";
export const RELEASE_FEED_URL: string | null =
  "https://github.com/Utopia-USS/cashu/releases/latest/download/";
