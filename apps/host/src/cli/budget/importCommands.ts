// Bank CSV imports over the native vault's existing parser and atomic event command.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, normalize, resolve, sep } from "node:path";
import { budget, core, ibanKey } from "@cashu/domain";
import { importStatement, runCommand } from "@cashu/store";
import { accountByGid, mcpAccounts, mcpProfile } from "@cashu/store/core";
import type { HostStores, OpenVault } from "../../stores.js";
import { printConsole, supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { importInput, importTextSupported } from "./importInput.js";

const DELEGATE = { kind: "delegate" } as const;
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
    // Python's OS exception contains platform-specific path/error representation. Delegate before
    // the first write instead of manufacturing a diagnostic after a partial native import.
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
): Promise<number | typeof DELEGATE> {
  const input = importInput(args, directory);
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!input || !slug || !supportsConsoleUnicode(io)) return DELEGATE;
  if (input.bank !== undefined && !registry.institutions.csvIds().includes(input.bank))
    return DELEGATE;
  if (!registry.accountTypes.ids().includes(input.accountType)) return DELEGATE;
  const vault = selected(deps, slug);
  if (!vault) return DELEGATE;
  const path = normalize(input.path);
  if (!importTextSupported(path) || (input.name !== undefined && !importTextSupported(input.name)))
    return DELEGATE;
  let paths: string[];
  try {
    const info = await stat(resolve(io.cwd, path));
    if (directory) {
      if (!info.isDirectory()) return DELEGATE;
      paths = (await filesIn(path, io.cwd, input.recursive)).sort(pathCompare);
    } else {
      if (!info.isFile()) return DELEGATE;
      paths = [path];
    }
  } catch {
    return DELEGATE;
  }
  // Prepare the entire invocation before mutation, so an unsupported later representation never
  // causes delegation after an earlier file already committed. Ordinary known parser failures
  // remain per-file failures, printed in the original sorted order.
  const prepared: PreparedFile[] = [];
  for (const file of paths) {
    if (io.signal.aborted) return 130;
    if (!importTextSupported(file)) return DELEGATE;
    const parent = basename(join(file, "..")).toLowerCase();
    const hint =
      input.bank ||
      (directory && registry.institutions.csvIds().includes(parent) ? parent : undefined);
    const value = await prepare(file, io.cwd, hint);
    if (!value || (!directory && value.error)) return DELEGATE;
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
      if (!importStatement.input.safeParse(command).success) return DELEGATE;
      if (
        !/^[A-Z]{3}$/.test(stmt.currency) ||
        stmt.transactions.some((t) => !/^[A-Z]{3}$/.test(t.currency.toUpperCase()))
      )
        return DELEGATE;
      const names = [input.name ?? "", stmt.accountName ?? ""];
      const key = stmt.accountNumber ? ibanKey(stmt.accountNumber) : null;
      for (const account of mcpAccounts(vault.store.read.bind(vault.store))) {
        if (key && ibanKey(account.iban) === key) {
          // Python's bank-local account identity differs from native cross-source IBAN identity.
          if (account.bank !== stmt.bank) return DELEGATE;
          names.push(account.name);
        }
      }
      if (names.some((name) => !importTextSupported(name))) return DELEGATE;
    }
    prepared.push(value);
  }
  let inserted = 0;
  let started = false;
  for (const file of prepared) {
    const outcome = await vault.queue.run(() => {
      if (io.signal.aborted) return 130;
      if (deps.stores.vaults.get(vault.id) !== vault || selected(deps, slug) !== vault) {
        if (!started) return DELEGATE;
        throw new Error("native import vault changed before append");
      }
      if (file.error) {
        started = true;
        const text = `${basename(file.path)}: ${file.error}`;
        printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 31 } }] });
        return 0;
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
        if (!started) return DELEGATE;
        throw new Error("native import account changed before append");
      }
      const result = runCommand(
        vault.store,
        vault.writer,
        importStatement,
        {
          statement: file.statement,
          accountType: input.accountType,
          accountName: input.name,
          source: "csv",
          filename: basename(file.path),
          newestDayRule: false,
        },
        vault.env,
      );
      if (!result.ok) throw new Error("native import refused validated statement");
      started = true;
      const account = accountByGid(vault.store.read.bind(vault.store), result.value.account);
      if (!account) throw new Error("native import did not materialize its account");
      inserted += result.value.numInserted;
      const filename = basename(file.path);
      const text = directory
        ? `${filename} -> ${account.bank} '${account.name}' [${account.currency}]: +${result.value.numInserted} (${result.value.numDuplicates} dup)`
        : `${filename} -> ${account.bank} '${account.name}': seen ${result.value.numSeen}, inserted ${result.value.numInserted}, duplicates ${result.value.numDuplicates}`;
      printConsole(io, text, { spans: [{ start: 0, end: filename.length, style: { color: 32 } }] });
      return 0;
    });
    if (outcome !== 0) return outcome;
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
