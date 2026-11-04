/** Refuses native vaults while a source root of this entry holds a Python cashU database. */

import { legacyDataAdmission, legacySourceRoots } from "@cashu/node-host/admission";

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
  return () => {
    if (legacyDataAdmission(roots) !== "no_legacy_sentinel") throw new Error("python_data_present");
  };
}
