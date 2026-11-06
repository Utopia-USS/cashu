// The statement import drawer's host actions on a genuine encrypted vault: preview stages the
// picked bytes, commit writes them once (a replay answers the same result), the done step's derived
// counts (categories, the transfer pair) are read after the append, refusals carry the drawer's codes.
// Counts follow the Python oracle sequence pinned in packages/store/src/budget/statement-import.test.ts.

import { toJson } from "@cashu/host-protocol/store";
import { statementContentBase64 } from "@cashu/store/budget/queries";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { budgetStatementActions } from "./budgetScreen.js";
import { startLocalHost } from "./host.js";
import { cleanup } from "./testing/harness.js";
import { nativeVaultFixture } from "./testing/nativeVaultFixture.js";

afterEach(cleanup);

const enc = (s: string) => statementContentBase64(new TextEncoder().encode(s));
const MBANK =
  "mBank S.A.;\n\n#Waluta;\nPLN;\n\n#Numer rachunku;\n99 1140 0000 0000 0000 0000 0001;\n\n" +
  "#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji;\n" +
  `2026-09-02;2026-09-02;ZAKUP PRZY UŻYCIU KARTY;"KAWIARNIA TEST";"KAWIARNIA TEST";'';-20,00;980,00;\n` +
  `2026-09-10;2026-09-10;PRZELEW WŁASNY;"OSZCZĘDNOŚCI";"JAN TESTOWY";'99124000000000000000000002';-1 000,00;-20,00;\n`;
const PEKAO =
  "Data księgowania;Data waluty;Nadawca / Odbiorca;Adres nadawcy / odbiorcy;Rachunek źródłowy;Rachunek docelowy;Tytułem;Kwota operacji;Waluta;Numer referencyjny;Typ operacji;Kategoria\n" +
  "10.09.2026;10.09.2026;JAN TESTOWY;;'99114000000000000000000001;'99124000000000000000000002;OSZCZĘDNOŚCI;1 000,00;PLN;C0000000000001;PRZELEW WŁASNY;Przelewy\n" +
  "12.09.2026;12.09.2026;SKLEP TEST;KRAKÓW;'99124000000000000000000002;;SKLEP TEST KRAKÓW;-50,00;PLN;C0000000000002;TRANSAKCJA KARTĄ PŁATNICZĄ;Zakupy\n";
const previewed = z.object({ status: z.literal("previewed"), stage: z.string() });

it("previews, commits once and reports the derived counts on a native vault", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  const manager = budgetStatementActions({ now: () => Date.now() });
  const [preview, commit] = manager.actions;
  if (!preview || !commit) throw new Error("missing actions");
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    uiActions: manager.actions,
  });
  try {
    const vault = fixture.vaultId;
    const firstInput = {
      fileName: "a.csv",
      content: enc(MBANK),
      importer: "auto",
      accountType: "checking",
      lang: "pl" as const,
    };
    // The renderer's client sends UI action input through the channel's plain JSON encoder.
    expect(() => toJson(firstInput)).not.toThrow();
    const p1 = await preview.run(host.stores, vault, firstInput);
    expect(p1).toMatchObject({
      status: "completed",
      value: {
        status: "previewed",
        preview: {
          importer: { id: "mbank", detected: true },
          account: { existing: false, name: "mBank 0001" },
          counts: { rows: 2, new: 2, duplicates: 0 },
        },
      },
    });
    const stage = previewed.parse((p1 as { value: unknown }).value).stage;
    const c1 = await commit.run(host.stores, vault, { stage });
    expect(c1).toMatchObject({
      status: "completed",
      value: {
        status: "committed",
        result: {
          inserted: 2,
          duplicates: 0,
          account: { name: "mBank 0001", created: true },
          categorized: 1,
          transferPairs: 0,
        },
      },
    });
    // a replay of the same stage answers the same result without a second batch
    expect(await commit.run(host.stores, vault, { stage })).toEqual(c1);
    const read = host.stores.vaults
      .get(vault)
      ?.store.read.bind(host.stores.vaults.get(vault)?.store);
    expect(read?.("SELECT gid FROM import_batches")).toHaveLength(1);

    const p2 = await preview.run(host.stores, vault, {
      fileName: "b.csv",
      content: enc(PEKAO),
      accountType: "savings",
      accountName: "Oszczędności",
      lang: "pl",
    });
    // a commit retried after an unknown outcome still answers its result once another preview ran
    expect(await commit.run(host.stores, vault, { stage })).toEqual(c1);
    const c2 = await commit.run(host.stores, vault, {
      stage: previewed.parse((p2 as { value: unknown }).value).stage,
    });
    expect(c2).toMatchObject({
      value: { status: "committed", result: { inserted: 2, transferPairs: 1 } },
    });

    // refusals the drawer shows: an unknown file, an empty one, an expired stage
    expect(
      await preview.run(host.stores, vault, {
        fileName: "x.csv",
        content: enc("a;b\n1;2\n"),
        lang: "pl",
      }),
    ).toMatchObject({ value: { status: "refused", code: "import_bank_unknown" } });
    expect(
      await preview.run(host.stores, vault, {
        fileName: "x.csv",
        content: "",
        lang: "pl",
      }),
    ).toMatchObject({ value: { status: "refused", code: "import_empty" } });
    expect(await commit.run(host.stores, vault, { stage: "missing" })).toMatchObject({
      value: { status: "refused", code: "not_found" },
    });
  } finally {
    manager.close();
    await host.stop();
    fixture.cleanup();
  }
});
