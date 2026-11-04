/** Refuses native vaults while a source root of this entry holds a Python cashU database. */

import { StartupFailureError } from "@cashu/host-protocol/startup-failure";
import {
  type LegacyDataAdmission,
  legacyDataAdmission,
  legacySourceRoots,
} from "@cashu/node-host/admission";

/**
 * Throws the typed refusal for an admission that is not clear: an unfinished in-place cutover is
 * `migration_incomplete` (`cashu migrate` finishes it), any Python data is `python_data_present`.
 */
export function assertLegacyAdmission(admission: LegacyDataAdmission): void {
  if (admission === "no_legacy_sentinel") return;
  if (admission === "migration_incomplete")
    throw new StartupFailureError("migration_incomplete", "cutover_failed");
  throw new StartupFailureError("python_data_present");
}

export function nativeSourceAdmission(input: {
  readonly dataDir: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly explicitDataDir: boolean;
}): () => void {
  const roots = legacySourceRoots(
    input.dataDir,
    input.projectRoot,
    input.home,
    input.env,
    input.platform,
    input.explicitDataDir,
  );
  return () => assertLegacyAdmission(legacyDataAdmission(roots));
}
