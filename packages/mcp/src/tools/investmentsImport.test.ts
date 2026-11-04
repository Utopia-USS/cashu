/** Actual Python validator diagnostics, including Unicode numeral values, in both privacy modes. */
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { nativeFixture } from "../testing/native.js";
import { validateInvestmentImport } from "./investmentsImport.js";

interface Vector {
  name: string;
  text: string;
  mapping: string | null;
  expected: Record<string, string>;
}
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/imports.json", import.meta.url), "utf8"),
) as Vector[];
const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
it.each(vectors)("matches Python value-free import diagnostics: $mapping", async (vector) => {
  const f = nativeFixture();
  fixtures.push(f);
  for (const mode of ["strict", "amounts"] as const) {
    const ctx = f.context(mode),
      redactor = new Redactor({ privacy: mode, guard: ctx.guard });
    const tree = await validateInvestmentImport(
      {
        ...ctx,
        store: {
          ...ctx.store,
          readInvestmentImportFile: () => ({
            name: vector.name,
            bytes: new TextEncoder().encode(vector.text),
          }),
        },
      },
      { path: vector.name, ...(vector.mapping === null ? {} : { mapping: vector.mapping }) },
    );
    const output = redactor.apply(tree);
    leakCheck(output, {
      strict: redactor.strict,
      isins: redactor.isins,
      nonMoney: redactor.nonMoney,
    });
    expect(JSON.parse(pyDumps(output))).toEqual(JSON.parse(vector.expected[mode] ?? "null"));
  }
});
