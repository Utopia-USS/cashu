// The strategy files of an imported vault. The native app reads its strategy only from
// `<vaultRoot>/strategy/strategy.yaml` and `strategy.md` (nativeVault/bindings.ts,
// proposals/strategyFiles.ts); the Python app kept them in `profiles/<slug>/`, and genesis refuses
// a source whose files differ from the newest stored version (D-G7). The import writes that
// version's texts there through the native writer, byte for byte, and verification reads them back
// through the native reader.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { GenesisVault } from "@cashu/store/genesis";
import { STRATEGY_MD, STRATEGY_YAML } from "@cashu/store/investments/services";
import { strategyDirectoryAccess } from "../../proposals/strategyFiles.js";
import { MigrationError } from "../contract.js";

/** The newest stored strategy version's texts; null for a profile without a strategy. */
export interface StrategyTexts {
  readonly yaml: string;
  readonly md: string | null;
}

/**
 * The texts of the source's newest version: genesis emits `strategy.versionSaved` in (version, id)
 * order, so the last one is the version the Python files equal.
 */
export function latestStrategyTexts(vault: GenesisVault): StrategyTexts | null {
  const latest = vault.events.filter((event) => event.t === "strategy.versionSaved").at(-1);
  if (latest === undefined) return null;
  const { yamlText, mdText } = latest.d;
  if (typeof yamlText !== "string" || (mdText !== null && typeof mdText !== "string"))
    throw new MigrationError("mapping_invalid");
  return { yaml: yamlText, md: mdText };
}

interface VaultStrategy {
  readonly vaultId: string;
  readonly vaultRoot: string;
  readonly texts: StrategyTexts | null;
  /** The caller's host lock is still held. */
  readonly isCurrent: () => boolean;
}

function access(input: VaultStrategy) {
  return strategyDirectoryAccess({
    vault: input.vaultId,
    privateRoot: input.vaultRoot,
    directory: join(input.vaultRoot, "strategy"),
    isCurrent: input.isCurrent,
  });
}

/** Writes the files into the vault's empty strategy folder, then checks them. */
export function writeMigratedStrategy(input: VaultStrategy): void {
  const { texts } = input;
  try {
    if (texts !== null) {
      const dir = access(input);
      if (dir.createAbsent(STRATEGY_YAML, texts.yaml) !== "created")
        throw new MigrationError("replay_mismatch");
      if (texts.md !== null && dir.createAbsent(STRATEGY_MD, texts.md) !== "created")
        throw new MigrationError("replay_mismatch");
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("replay_mismatch");
  }
  assertMigratedStrategy(input);
}

/** The folder holds exactly the version's files, and the native reader returns their texts. */
export function assertMigratedStrategy(input: VaultStrategy): void {
  const { texts } = input;
  try {
    const dir = access(input);
    const expected =
      texts === null ? [] : texts.md === null ? [STRATEGY_YAML] : [STRATEGY_MD, STRATEGY_YAML];
    const names = readdirSync(dir.directory).sort();
    if (
      JSON.stringify(names) !== JSON.stringify(expected) ||
      dir.readFixed(STRATEGY_YAML) !== (texts?.yaml ?? null) ||
      dir.readFixed(STRATEGY_MD) !== (texts?.md ?? null)
    )
      throw new MigrationError("replay_mismatch");
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("replay_mismatch");
  }
}
