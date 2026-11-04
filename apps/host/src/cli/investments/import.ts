import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  MAX_FILE_BYTES,
  planDuplicateCount,
  planNewCount,
  positionDelta,
  reportMismatches,
} from "@cashu/domain/investments/importing";
import { investmentsCommands } from "@cashu/store";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import { previewImport } from "@cashu/store/investments/queries";
import { publishCheckedImportBlob } from "@cashu/store/investments/services";
import type { NativeBlobPublication } from "../../nativeBlobs.js";
import { cliCommandKey, reportCliCommandFailure, runCliVaultCommand } from "../commandOutcome.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { UNHANDLED } from "./inspection.js";
import { investmentCliText as M } from "./strings.js";

interface Input {
  file: string;
  account: string;
  mapping?: string;
  importer: string;
  dryRun: boolean;
  applyCorrections: boolean;
}

function parse(args: readonly string[]): Input | null {
  let file: string | undefined;
  let account: string | undefined;
  let mapping: string | undefined;
  let importer = "auto";
  let dryRun = false;
  let applyCorrections = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) return null;
    if (arg === "--dry-run" && !dryRun) {
      dryRun = true;
      continue;
    }
    if (arg === "--apply-corrections" && !applyCorrections) {
      applyCorrections = true;
      continue;
    }
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    const canonical = flag === "-a" ? "--account" : flag;
    if (["--account", "--mapping", "--importer"].includes(canonical)) {
      if (seen.has(canonical)) return null;
      seen.add(canonical);
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (!value || value.startsWith("--")) return null;
      if (canonical === "--account") account = value;
      if (canonical === "--mapping") mapping = value;
      if (canonical === "--importer") importer = value;
    } else if (!arg.startsWith("-") && file === undefined) file = arg;
    else return null;
  }
  return file && account
    ? { file, account, importer, dryRun, applyCorrections, ...(mapping ? { mapping } : {}) }
    : null;
}

/** A CLI-supplied local file, read once without following a final symlink or trusting a prior stat. */
async function readBounded(cwd: string, path: string, limit: number): Promise<Uint8Array | null> {
  const full = resolve(cwd, path);
  const before = await lstat(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) return null;
  const handle = await open(
    full,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      return null;
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(full);
    return after.size === opened.size &&
      after.mtimeMs === opened.mtimeMs &&
      after.ctimeMs === opened.ctimeMs &&
      named.dev === opened.dev &&
      named.ino === opened.ino &&
      named.size === opened.size &&
      named.ctimeMs === opened.ctimeMs &&
      !named.isSymbolicLink()
      ? bytes
      : null;
  } finally {
    await handle.close();
  }
}

export async function importFile(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): Promise<number | typeof UNHANDLED> {
  const input = parse(args);
  const vault = investmentVault(io, root, deps);
  if (!input || !vault) return UNHANDLED;
  if (io.signal.aborted) return 130;
  const slug = root.profile || io.env.CASHU_PROFILE;
  const read = vault.store.read.bind(vault.store);
  const current = () =>
    !io.signal.aborted &&
    deps.stores.vaults.get(vault.id) === vault &&
    mcpProfile(read)?.slug === slug &&
    enabledModuleIds(read).has("investments") &&
    vault.mode === "native" &&
    vault.native.isCurrent();
  if (!current()) return UNHANDLED;
  let content: Uint8Array | null;
  let mappingYaml: string | undefined;
  try {
    content = await readBounded(io.cwd, input.file, MAX_FILE_BYTES);
    if (input.mapping) {
      const mapped = await readBounded(io.cwd, input.mapping, 1_048_576);
      if (mapped === null) return UNHANDLED;
      mappingYaml = new TextDecoder("utf-8", { fatal: true }).decode(mapped);
    }
  } catch {
    return UNHANDLED;
  }
  if (content === null || content.length === 0 || !current()) return UNHANDLED;
  if (io.signal.aborted) return 130;
  const file = { name: basename(input.file), content };
  const request = {
    account: input.account,
    file,
    importer: input.importer,
    ...(mappingYaml === undefined ? {} : { mappingYaml }),
  };
  const previewed = previewImport(read, request, new Date(deps.now()).toISOString());
  if (!previewed.ok) return UNHANDLED;
  const preview = previewed.preview;
  printConsole(io, `${file.name}: ${io.t.tr(M.importer)} ${preview.importerId ?? "-"}`, {
    highlight: false,
  });
  const plan = preview.plan;
  if (plan) {
    printConsole(
      io,
      `  ${io.t.tr(M.rows)}: ${plan.rows.length}, ${io.t.tr(M.newRows)}: ${planNewCount(plan)}, ${io.t.tr(M.duplicates)}: ${planDuplicateCount(plan)}, ${io.t.tr(M.positions)}: ${plan.positions.length}, ${io.t.tr(M.renames)}: ${plan.renames.length}, ${io.t.tr(M.delistings)}: ${plan.statusChanges.length}, ${io.t.tr(M.newInstruments)}: ${plan.newInstruments.length}`,
      { highlight: false },
    );
    for (const instrument of plan.newInstruments)
      printConsole(
        io,
        `  ${io.t.tr(M.newInstrument)}: ${instrument.symbol || instrument.name} (${instrument.currency}, ${instrument.assetClass})`,
        { highlight: false },
      );
  }
  for (const warning of preview.warnings)
    printConsole(io, `  ${io.t.tr(M.warning)} ${warning.message}`, { highlight: false });
  for (const error of preview.errors)
    printConsole(io, `  ${io.t.tr(M.error)} ${error.message}`, { highlight: false });
  if (preview.reconciliation) {
    for (const diff of reportMismatches(preview.reconciliation)) {
      const instrument = plan?.instruments.get(diff.instrumentId);
      const label = instrument?.symbol || instrument?.name || diff.instrumentId;
      printConsole(
        io,
        `  ${io.t.tr(M.reconciliation)} ${label}: ${io.t.tr(M.brokerQuantity)} ${diff.brokerQuantity}, ${io.t.tr(M.historyQuantity)} ${diff.computedQuantity} (${io.t.tr(M.delta)} ${positionDelta(diff)})`,
        { highlight: false },
      );
    }
  }
  const corrections = preview.reconciliation?.corrections.map((row) => row.diff.instrumentId) ?? [];
  if (!preview.canCommit) {
    printConsole(io, io.t.tr(M.notImported));
    return 1;
  }
  if (input.dryRun) {
    printConsole(io, io.t.tr(M.dryRun));
    return 0;
  }
  let publication: NativeBlobPublication | null;
  try {
    publication = vault.mode === "native" ? vault.native.blobPublication() : null;
  } catch {
    publication = null;
  }
  const currentPublication = () => {
    try {
      return (
        current() &&
        publication?.vault === vault.id &&
        publication.isCurrent() &&
        vault.mode === "native" &&
        vault.native.blobPublication() === publication
      );
    } catch {
      return false;
    }
  };
  if (!publication || !currentPublication() || !vault.env.lease.isHolder()) {
    io.stderr(`${io.t.tr(M.importUnavailable)}\n`);
    return 1;
  }
  const key = cliCommandKey();
  let archive: Awaited<ReturnType<typeof publishCheckedImportBlob>>;
  try {
    archive = await publishCheckedImportBlob(publication, vault.id, file, io.signal);
  } catch {
    io.stderr(`${io.t.tr(M.importUnavailable)}\n`);
    return 1;
  }
  if (!currentPublication()) {
    io.stderr(`${io.t.tr(M.importUnavailable)}\n`);
    return 1;
  }
  const committed = await runCliVaultCommand(
    vault,
    investmentsCommands.commitImport,
    {
      ...request,
      corrections: input.applyCorrections ? corrections : [],
      archive: archive.blob,
    },
    key,
    currentPublication,
  ).catch(() => null);
  if (committed === null) {
    io.stderr(
      `${io.t.tr(M.unknownOutcome)} cashu command-status ${investmentsCommands.commitImport.id} ${key}. ${io.t.tr(M.doNotRetry)}\n`,
    );
    return 1;
  }
  if (committed.kind !== "completed")
    return reportCliCommandFailure(io, committed, key, investmentsCommands.commitImport.id);
  printConsole(
    io,
    `${io.t.tr(M.imported)} ${committed.value.inserted} ${io.t.tr(M.transactions)} (${io.t.tr(M.batch)} ${committed.value.batch}), ${committed.value.duplicates} ${io.t.tr(M.duplicates)}; ${committed.value.newInstruments.length} ${io.t.tr(M.newInstruments)}; ${committed.value.corrections} ${io.t.tr(M.corrections)}. ${io.t.tr(M.archived)} ${committed.value.archive}`,
    { highlight: false },
  );
  return 0;
}
