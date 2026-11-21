// validate_import diagnostics are value-free in both modes: an unrecognised file names the importer
// error, a broken generic CSV mapping reports its paths and lines, and a mapping value in non-Latin
// digits is never echoed back.
import { afterEach, expect, it } from "vitest";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { nativeFixture } from "../testing/native.js";
import { validateInvestmentImport } from "./investmentsImport.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function validate(mapping: string | null) {
  const f = nativeFixture();
  fixtures.push(f);
  const out: Record<string, unknown> = {};
  for (const mode of ["strict", "amounts"] as const) {
    const ctx = f.context(mode),
      redactor = new Redactor({ privacy: mode, guard: ctx.guard });
    const tree = await validateInvestmentImport(
      {
        ...ctx,
        store: {
          ...ctx.store,
          readInvestmentImportFile: () => ({
            name: "invalid.csv",
            bytes: new TextEncoder().encode("invalid\n"),
          }),
        },
      },
      { path: "invalid.csv", ...(mapping === null ? {} : { mapping }) },
    );
    const output = redactor.apply(tree);
    leakCheck(output, {
      strict: redactor.strict,
      isins: redactor.isins,
      nonMoney: redactor.nonMoney,
    });
    out[mode] = JSON.parse(pyDumps(output));
  }
  expect(out.amounts).toEqual(out.strict);
  return out.strict as Record<string, unknown>;
}

it("names the importer error of an unrecognised file", async () => {
  expect(await validate(null)).toMatchObject({
    importer: "cashu",
    ok: false,
    errors: 1,
    errors_by_kind: [{ count: 1, kind: "importer_error", rows: [] }],
  });
});

it("reports mapping errors by path and line without echoing their values", async () => {
  expect(await validate("version: ١٢٣\n")).toEqual({
    importer: "generic_csv",
    ok: false,
    mapping_errors: [
      { line: 1, message: "Unsupported mapping version # (expected #)", path: "version" },
      {
        line: 1,
        message: "Missing required key (map at least trade_date, type and an amount)",
        path: "columns",
      },
    ],
  });
  const columns = await validate("version: 1\ncolumns: {type: ١٢٣}\n");
  expect(columns.mapping_errors).toEqual([
    { line: 2, message: "Missing required field trade_date", path: "columns" },
    { line: 2, message: "Map cash_amount, gross_amount, or quantity and price", path: "columns" },
    { line: 2, message: "Map a currency column or set default_currency", path: "columns" },
  ]);
});
