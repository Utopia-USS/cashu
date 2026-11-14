// Pure selection shared by native vault reads and the read-only Python parity adapter.
import { ibanKey, PY_W, uRegex } from "@cashu/domain";
import { merchantKey } from "@cashu/domain/budget";
import type { BudgetNameRow } from "@cashu/store/budget/queries";
import { looksLikePerson, type NameSources, normalize } from "../privacy/names.js";

export type { BudgetNameRow } from "@cashu/store/budget/queries";

const TRANSFER = uRegex(
  `(?<![${PY_W}])(?:PRZELEW[${PY_W}]*|BLIK|TRANSFER|P2P|NA TELEFON|ZWROT DLA|DLA|OD|DO|PRZEKAZ[${PY_W}]*)(?![${PY_W}])`,
);
export function budgetNameSources(
  rows: readonly BudgetNameRow[],
  ownIbans: ReadonlySet<string>,
): NameSources {
  const persons = new Set<string>();
  const privatePayees = new Set<string>();
  for (const row of rows) {
    const name = row.counterpartyName;
    if (name !== null) {
      if (!name) continue;
      if (row.internal || (row.counterpartyIban && ownIbans.has(ibanKey(row.counterpartyIban))))
        persons.add(name);
      else if (row.counterpartyIban && looksLikePerson(name)) privatePayees.add(merchantKey(name));
    } else {
      const key = merchantKey(null, row.reference, row.description);
      if (
        key &&
        (row.counterpartyIban ||
          TRANSFER.test(normalize(`${row.reference ?? ""} ${row.description ?? ""}`)))
      )
        privatePayees.add(key);
    }
  }
  return { persons, privatePayees };
}
