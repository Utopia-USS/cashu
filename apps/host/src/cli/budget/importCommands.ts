// Bank CSV imports over the native vault's existing parser and atomic event command.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, normalize, resolve, sep } from "node:path";
import { budget, core, ibanKey } from "@cashu/domain";
import { importStatement } from "@cashu/store";
import { accountByGid, mcpAccounts, mcpProfile } from "@cashu/store/core";
import type { HostStores, OpenVault } from "../../stores.js";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import { printConsole } from "../core/console.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { importInput, importTextSupported } from "./importInput.js";

const UNHANDLED = { kind: "unhandled" } as const;
const registry = core.builtinRegistry();
export interface ImportDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
}
interface PreparedFile {
  readonly path: string;
  readonly statement?: budget.ParsedStatement;
  readonly error?: string;
}
function selected(deps: ImportDeps, slug: string): OpenVault | undefined {
  const matches = [...deps.stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === slug,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
/** pathlib sorts path components, not the string containing separators. */
function pathCompare(left: string, right: string): number {
  const a = left.split(sep),
    b = right.split(sep);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = budget.codePointCompare(a[i] ?? "", b[i] ?? "");
    if (order) return order;
  }
  return a.length - b.length;
}
async function filesIn(path: string, cwd: string, recursive: boolean): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(resolve(cwd, path), { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.name.endsWith(".csv")) paths.push(child);
    // Like pathlib.rglob, do not follow directory symlinks.
    if (recursive && entry.isDirectory()) paths.push(...(await filesIn(child, cwd, true)));
  }
  return paths;
}
async function prepare(
  path: string,
  cwd: string,
  bank?: string,
): Promise<PreparedFile | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolve(cwd, path));
  } catch {
    // Refuse before the first write; a later file failure must not leave a partial import.
    return undefined;
  }
  const parsed = budget.parseStatementFile(bytes, registry.institutions, bank);
  if (parsed.ok) return { path, statement: parsed.statement };
  const name = basename(path);
  if (parsed.reason === "not_detected")
    return {
      path,
      error: `Could not auto-detect the bank for ${name}. Pass the bank explicitly (--bank ${registry.institutions.csvIds().join("|")}).`,
    };
  if (parsed.reason === "no_header") {
    const chosen = bank || budget.detectBank(bytes, registry.institutions);
    if (!chosen) return undefined;
    return {
      path,
      error: `${chosen}: could not locate a ${chosen === "pekao" ? "" : "transaction "}header row in ${name}`,
    };
  }
  if (parsed.reason === "bad_amount")
    return { path, error: "[<class 'decimal.ConversionSyntax'>]" };
  // Typed parser failures deliberately omit raw exception values; do not invent Python text.
  return undefined;
}

export async function runImportCommand(
  directory: boolean,
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: ImportDeps,
): Promise<number | typeof UNHANDLED> {
  const input = importInput(args, directory);
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!input || !slug) return UNHANDLED;
  if (input.bank !== undefined && !registry.institutions.csvIds().includes(input.bank))
    return UNHANDLED;
  if (!registry.accountTypes.ids().includes(input.accountType)) return UNHANDLED;
  const vault = selected(deps, slug);
  if (!vault) return UNHANDLED;
  const path = normalize(input.path);
  if (!importTextSupported(path) || (input.name !== undefined && !importTextSupported(input.name)))
    return UNHANDLED;
  let paths: string[];
  try {
    const info = await stat(resolve(io.cwd, path));
    if (directory) {
      if (!info.isDirectory()) return UNHANDLED;
      paths = (await filesIn(path, io.cwd, input.recursive)).sort(pathCompare);
    } else {
      if (!info.isFile()) return UNHANDLED;
      paths = [path];
    }
  } catch {
    return UNHANDLED;
  }
  // Prepare the entire invocation before mutation, so a later unsupported representation never
  // follows an earlier committed file. Ordinary known parser failures
  // remain per-file failures, printed in the original sorted order.
  const prepared: PreparedFile[] = [];
  for (const file of paths) {
    if (io.signal.aborted) return 130;
    if (!importTextSupported(file)) return UNHANDLED;
    const parent = basename(join(file, "..")).toLowerCase();
    const hint =
      input.bank ||
      (directory && registry.institutions.csvIds().includes(parent) ? parent : undefined);
    const value = await prepare(file, io.cwd, hint);
    if (!value || (!directory && value.error)) return UNHANDLED;
    if (value.statement) {
      const stmt = value.statement;
      const command = {
        statement: stmt,
        accountType: input.accountType,
        accountName: input.name,
        source: "csv" as const,
        filename: basename(file),
        newestDayRule: false,
      };
      if (!importStatement.input.safeParse(command).success) return UNHANDLED;
      if (
        !/^[A-Z]{3}$/.test(stmt.currency) ||
        stmt.transactions.some((t) => !/^[A-Z]{3}$/.test(t.currency.toUpperCase()))
      )
        return UNHANDLED;
      const names = [input.name ?? "", stmt.accountName ?? ""];
      const key = stmt.accountNumber ? ibanKey(stmt.accountNumber) : null;
      for (const account of mcpAccounts(vault.store.read.bind(vault.store))) {
        if (key && ibanKey(account.iban) === key) {
          // Python's bank-local account identity differs from native cross-source IBAN identity.
          if (account.bank !== stmt.bank) return UNHANDLED;
          names.push(account.name);
        }
      }
      if (names.some((name) => !importTextSupported(name))) return UNHANDLED;
    }
    prepared.push(value);
  }
  let inserted = 0;
  let started = false;
  let completedWrites = 0;
  const stopped = (reason: string): number => {
    io.stderr(`Import stopped (${reason}). Completed earlier imports: ${completedWrites}.\n`);
    return 1;
  };
  for (const file of prepared) {
    const commandKey = cliCommandKey();
    if (io.signal.aborted) {
      if (started)
        io.stderr(`Import interrupted. Completed earlier imports: ${completedWrites}.\n`);
      return 130;
    }
    if (deps.stores.vaults.get(vault.id) !== vault || selected(deps, slug) !== vault) {
      if (!started) return UNHANDLED;
      return stopped("vault_changed");
    }
    if (file.error) {
      started = true;
      const text = `${basename(file.path)}: ${file.error}`;
      printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 31 } }] });
      continue;
    }
    if (!file.statement) throw new Error("native import has no parsed statement");
    const key = file.statement.accountNumber ? ibanKey(file.statement.accountNumber) : null;
    const changedAccount = mcpAccounts(vault.store.read.bind(vault.store)).some(
      (account) =>
        key &&
        ibanKey(account.iban) === key &&
        (account.bank !== file.statement?.bank || !importTextSupported(account.name)),
    );
    if (changedAccount) {
      if (!started) return UNHANDLED;
      return stopped("account_changed");
    }
    const result = await runCliVaultCommand(
      vault,
      importStatement,
      {
        statement: file.statement,
        accountType: input.accountType,
        accountName: input.name,
        source: "csv",
        filename: basename(file.path),
        newestDayRule: false,
      },
      commandKey,
      () => {
        if (deps.stores.vaults.get(vault.id) !== vault || selected(deps, slug) !== vault)
          return false;
        const accountKey = file.statement?.accountNumber
          ? ibanKey(file.statement.accountNumber)
          : null;
        return !mcpAccounts(vault.store.read.bind(vault.store)).some(
          (account) =>
            accountKey &&
            ibanKey(account.iban) === accountKey &&
            (account.bank !== file.statement?.bank || !importTextSupported(account.name)),
        );
      },
    );
    if (result.kind !== "completed") {
      io.stderr(`Completed earlier imports: ${completedWrites}.\n`);
      return reportCliCommandFailure(io, result, commandKey, importStatement.id);
    }
    started = true;
    completedWrites += 1;
    let account: ReturnType<typeof accountByGid>;
    try {
      account = accountByGid(vault.store.read.bind(vault.store), result.value.account);
    } catch {
      io.stderr(`Completed imports: ${completedWrites}.\n`);
      return reportCliProjectionUnavailable(io, commandKey, importStatement.id);
    }
    if (!account) {
      io.stderr(`Completed imports: ${completedWrites}.\n`);
      return reportCliProjectionUnavailable(io, commandKey, importStatement.id);
    }
    inserted += result.value.numInserted;
    const filename = basename(file.path);
    const text = directory
      ? `${filename} -> ${account.bank} '${account.name}' [${account.currency}]: +${result.value.numInserted} (${result.value.numDuplicates} dup)`
      : `${filename} -> ${account.bank} '${account.name}': seen ${result.value.numSeen}, inserted ${result.value.numInserted}, duplicates ${result.value.numDuplicates}`;
    printConsole(io, text, { spans: [{ start: 0, end: filename.length, style: { color: 32 } }] });
  }
  if (directory) {
    if (prepared.length === 0) {
      const text = `No .csv files in ${path}`;
      printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 33 } }] });
    } else {
      const text = `Inserted ${inserted} new transaction(s).`;
      printConsole(io, `${text} (categorized)`, {
        spans: [{ start: 0, end: text.length, style: { bold: true } }],
      });
    }
  }
  return 0;
}

export function importCommands(deps: ImportDeps): PortedCommand[] {
  return ["import-csv", "import-dir"].map((name) => ({
    name,
    run: (args, io, root) => runImportCommand(name === "import-dir", args, io, root, deps),
  }));
}
