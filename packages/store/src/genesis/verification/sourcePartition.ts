import type { SqlDriver } from "../../sql/driver.js";
import type { GenesisResult } from "../index.js";
import { ROUNDTRIP_COLUMNS } from "./columns.js";

export class SourcePartitionError extends Error {
  constructor() {
    super("source_partition_mismatch");
    this.name = "SourcePartitionError";
  }
}

const TABLE = /^[a-z][a-z0-9_]*$/;
const GLOBAL = new Set(["inv_instruments", "inv_instrument_aliases"]);

/**
 * The source profile set and every scoped row are read independently of exported vaults/maps.
 * This closes the omitted-whole-vault case and rejects rows stranded under a missing profile or
 * account. Global instrument membership has its own exact closure audit.
 */
export function assertCompleteSourcePartition(
  driver: SqlDriver,
  result: GenesisResult,
  keySlugs: ReadonlySet<string>,
): { readonly profiles: number; readonly scopedRows: number } {
  const profiles = driver
    .prepare("SELECT id, slug FROM profiles ORDER BY id")
    .all<{ id: number; slug: string }>();
  if (
    profiles.length === 0 ||
    profiles.length !== result.vaults.length ||
    keySlugs.size !== profiles.length ||
    new Set(profiles.map((profile) => profile.slug)).size !== profiles.length
  ) {
    throw new SourcePartitionError();
  }
  for (const [ordinal, source] of profiles.entries()) {
    const exported = result.vaults[ordinal];
    if (
      !Number.isSafeInteger(source.id) ||
      source.id <= 0 ||
      typeof source.slug !== "string" ||
      source.slug.length === 0 ||
      !keySlugs.has(source.slug) ||
      exported?.ordinal !== ordinal ||
      exported.profileId !== source.id ||
      exported.slug !== source.slug
    ) {
      throw new SourcePartitionError();
    }
  }
  let scopedRows = 0;
  for (const table of [...Object.keys(ROUNDTRIP_COLUMNS), "inv_notification_log"]) {
    if (!TABLE.test(table) || table === "profiles" || GLOBAL.has(table)) continue;
    const columns = driver
      .prepare(`PRAGMA table_info("${table}")`)
      .all<{ name: string; notnull: number }>();
    if (columns.length === 0) throw new SourcePartitionError();
    const hasProfile = columns.some((row) => row.name === "profile_id");
    const hasAccount = columns.some((row) => row.name === "account_id");
    if (!hasProfile && !hasAccount) throw new SourcePartitionError();
    const total = driver.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get<{ n: number }>()?.n;
    const nullableAccount = columns.some((row) => row.name === "account_id" && row.notnull === 0);
    const join = hasProfile
      ? `JOIN profiles p ON p.id=t.profile_id${hasAccount ? " LEFT JOIN accounts a ON a.id=t.account_id AND a.profile_id=p.id" : ""}`
      : "JOIN accounts a ON a.id=t.account_id JOIN profiles p ON p.id=a.profile_id";
    const where =
      hasProfile && hasAccount
        ? `WHERE ${nullableAccount ? "t.account_id IS NULL OR " : ""}a.id IS NOT NULL`
        : "";
    const valid = driver
      .prepare(`SELECT COUNT(*) AS n FROM "${table}" t ${join} ${where}`)
      .get<{ n: number }>()?.n;
    if (
      typeof total !== "number" ||
      typeof valid !== "number" ||
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(valid) ||
      total < 0 ||
      valid !== total
    ) {
      throw new SourcePartitionError();
    }
    scopedRows += total;
  }
  return { profiles: profiles.length, scopedRows };
}
