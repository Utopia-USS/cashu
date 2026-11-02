/** Import validation reads only through an injected checked-file authority. */
import { PY_B, PY_D, PY_WS, pyStrip, uRegex } from "@cashu/domain";
import * as importing from "@cashu/domain/investments/importing";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";

const NO_SCRIPTS =
  "MCP calls never make the app run code: run a one-off converter yourself (python3 <script> <export> <output.csv>) and pass the cashu-format output file, or write a connector (propose_connector), which the app runs only after the owner approves it in Ustawienia > Konektory";
const SCRIPTS = new Set(
  "py pyw pyc pyz sh bash zsh command js mjs cjs ts rb pl php ps1 bat cmd exe jar applescript scpt".split(
    " ",
  ),
);
function refuseScript(value: string | undefined, what: string): void {
  if (
    value !== undefined &&
    !value.includes("\n") &&
    SCRIPTS.has(pyStrip(value).split(".").pop()?.toLowerCase() ?? "")
  )
    throw new ToolError(`${what} is a script; ${NO_SCRIPTS}`, "script_refused");
}
/** Remove quoted values and bare numbers before any importer diagnostic reaches the redactor. */
function importValueFree(message: string): string {
  return message
    .replace(/'[^']*'|"[^"]*"/gu, "'<value>'")
    .replace(/\(got [^)]*\)/gu, "(got <value>)")
    .replace(uRegex(`${PY_B}got (?!<value>)[^${PY_WS})]+`, "g"), "got <value>")
    .replace(
      uRegex(`(?<!row )(?<!line )(?<!column )(?<!rows )${PY_B}${PY_D}[${PY_D}.,]*${PY_B}`, "g"),
      "#",
    );
}
function byKind(issues: readonly importing.ImportWarning[]): L.LabelledTree {
  const groups = new Map<string, importing.ImportWarning[]>();
  for (const issue of issues) {
    const items = groups.get(issue.kind) ?? [];
    items.push(issue);
    groups.set(issue.kind, items);
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, items]) => ({
      kind: L.category(kind),
      count: L.count(items.length),
      rows: items.flatMap((i) => (i.row === null ? [] : [L.count(i.row)])).slice(0, 20),
      example: L.text(importValueFree(items[0]?.message ?? "")),
    }));
}
export function validateInvestmentImport(
  ctx: ToolContext<NativeToolStore>,
  args: ToolArgs,
): L.LabelledTree {
  const path = typeof args.path === "string" ? args.path : "",
    mapping = typeof args.mapping === "string" ? args.mapping : undefined;
  refuseScript(path, "path");
  refuseScript(mapping, "mapping");
  const read = ctx.store.readInvestmentImportFile;
  if (read === undefined)
    throw new ToolError("local file validation is unavailable", "unsupported");
  const file = read(path),
    used = mapping ? "generic_csv" : "cashu";
  let importer: importing.BrokerImporter | undefined;
  if (mapping) {
    let text = mapping;
    const candidate = pyStrip(mapping);
    if (!candidate.includes("\n") && /\.ya?ml$/iu.test(candidate)) {
      const readMapping = ctx.store.readInvestmentMappingFile;
      if (readMapping === undefined)
        throw new ToolError("local mapping files are unavailable", "unsupported");
      text = readMapping(candidate);
    }
    const parsed = importing.csvMappingFromYaml(text);
    if (!parsed.ok)
      return {
        ok: L.flag(false),
        importer: L.category("generic_csv"),
        mapping_errors: parsed.issues.map((i) => ({
          path: L.text(i.path),
          message: L.text(importValueFree(i.message)),
          line: L.count(i.line),
        })),
      };
    importer = new importing.GenericCsvImporter(parsed.mapping);
  }
  const report = importing.validateImport({ name: file.name, content: file.bytes }, importer);
  return {
    ok: L.flag(importing.reportOk(report)),
    importer: L.category(report.importerId ?? used),
    via: L.text(used),
    transactions: L.count(importing.reportTxnCount(report)),
    positions: L.count(importing.reportPositionCount(report)),
    corporate_actions: L.count(importing.reportCorporateActionCount(report)),
    errors: L.count(report.errors.length),
    warnings: L.count(report.warnings.length),
    errors_by_kind: byKind(report.errors),
    warnings_by_kind: byKind(report.warnings),
  };
}
