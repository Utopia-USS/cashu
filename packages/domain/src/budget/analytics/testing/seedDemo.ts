/**
 * `tests/conftest.py:seed_demo`, the budget half: the synthetic household of the Python API tests
 * (June-September 2026: a PLN checking account with salary, rent, mortgage installment, card spending
 * and a monthly 1000 to savings; an EUR account with a monthly subscription; a savings account), then
 * the transfer match and categorization, the September ATM withdrawal moved into the cash pool and one
 * 40 PLN cash expense. The assets / loans positions of the Python seed hold no transactions; their
 * accounts are listed so account order and own IBANs match. Synthetic data only.
 */

import { Household, type Raw } from "./household.js";

export const IBAN_MAIN = "99114000000000000000000001";
export const IBAN_EUR = "99114000000000000000000002";
const IBAN_SAVINGS = "99109000000000000000000003";
const IBAN_EMPLOYER = "99102000000000000000000777";
const IBAN_MORTGAGE_BANK = "99160000000000000000000555";
const IBAN_WSPOLNOTA = "99105000000000000000000333";
const SEED_YEAR = 2026;
const SEED_MONTHS = [6, 7, 8, 9] as const;

const pad = (n: number) => String(n).padStart(2, "0");

export function seedDemo(): Household {
  const h = new Household("PLN");
  const main = h.account({ name: "mKonto Test", iban: IBAN_MAIN });
  const eur = h.account({ name: "eKonto EUR Test", iban: IBAN_EUR, currency: "EUR" });
  const sav = h.account({ name: "Erste Test", iban: IBAN_SAVINGS, type: "savings" });

  const mainRows: Raw[] = [];
  const eurRows: Raw[] = [
    { date: `${SEED_YEAR}-06-01`, amount: "500.00", ref: "ZASILENIE", currency: "EUR" },
  ];
  const savRows: Raw[] = [];
  for (const m of SEED_MONTHS) {
    const d = (day: number) => `${SEED_YEAR}-${pad(m)}-${pad(day)}`;
    mainRows.push(
      { date: d(2), amount: "-139.00", ref: "KLUB SPORTOWY TEST", desc: "ZAKUP PRZY UZYCIU KARTY" },
      {
        date: d(3),
        amount: "-650.00",
        ref: "CZYNSZ",
        cp: "WSPOLNOTA MIESZKANIOWA TEST",
        iban: IBAN_WSPOLNOTA,
        desc: "PRZELEW WYCHODZACY",
      },
      {
        date: d(5),
        amount: "-3000.00",
        ref: "RATA KREDYTU HIPOTECZNEGO",
        cp: "BANK HIPOTECZNY TEST",
        iban: IBAN_MORTGAGE_BANK,
        desc: "PRZELEW WYCHODZACY",
      },
      {
        date: d(6),
        amount: `-${100 + m}.50`,
        ref: "BIEDRONKA 123 TEST",
        desc: "ZAKUP PRZY UZYCIU KARTY",
      },
      { date: d(7), amount: "-43.00", ref: "NETFLIX.COM", desc: "ZAKUP PRZY UZYCIU KARTY" },
      {
        date: d(10),
        amount: "9000.00",
        ref: `WYNAGRODZENIE ZA ${pad(m - 1)}/${SEED_YEAR}`,
        iban: IBAN_EMPLOYER,
        desc: "PRZELEW PRZYCHODZACY",
      },
      {
        date: d(11),
        amount: "-1000.00",
        ref: "OSZCZEDNOSCI",
        cp: "Erste Test",
        iban: IBAN_SAVINGS,
        desc: "PRZELEW WYCHODZACY",
      },
      {
        date: d(15),
        amount: "-300.00",
        ref: "WYPLATA W BANKOMACIE TEST",
        desc: "WYPLATA W BANKOMACIE",
      },
      {
        date: d(20),
        amount: `-${60 + 2 * m}.25`,
        ref: "BIEDRONKA 123 TEST",
        desc: "ZAKUP PRZY UZYCIU KARTY",
      },
      {
        date: d(21),
        amount: `-${200 + m}.00`,
        ref: "ORLEN STACJA TEST",
        desc: "ZAKUP PRZY UZYCIU KARTY",
      },
      { date: d(28), amount: "-7.00", ref: "OPLATA ZA KARTE", desc: "OPLATA" },
    );
    eurRows.push({ date: d(14), amount: "-9.99", ref: "SPOTIFY TEST", currency: "EUR" });
    savRows.push({
      date: d(11),
      amount: "1000.00",
      ref: "OSZCZEDNOSCI",
      cp: "mKonto Test",
      iban: IBAN_MAIN,
    });
  }
  // one merchant no rule knows -> "other" / default
  mainRows.push({ date: `${SEED_YEAR}-08-25`, amount: "-55.00", ref: "SKLEP NIEZNANY TEST" });

  h.ingest(main, mainRows);
  h.ingest(eur, eurRows);
  h.ingest(sav, savRows);
  const end = `${SEED_YEAR}-09-30`;
  h.balance(main, end, "5000.00");
  h.balance(eur, end, "460.04");
  h.balance(sav, end, "24000.00");
  // assets.add_manual_position / set_vehicle: accounts without transactions
  const property = h.account({ name: "Mieszkanie Test", type: "property" });
  h.balance(property, `${SEED_YEAR}-06-01`, "600000");
  const mortgage = h.account({ name: "Kredyt hipoteczny Test", type: "mortgage" });
  h.balance(mortgage, `${SEED_YEAR}-06-01`, "390000");
  h.account({ name: "Auto Test", type: "vehicle" });

  h.categorize();
  const atm = h.find(
    (t) =>
      t.account === main &&
      t.reference === "WYPLATA W BANKOMACIE TEST" &&
      t.bookingDate === `${SEED_YEAR}-09-15`,
  );
  h.setCategory(atm.key, "cash_withdrawal");
  h.cashExpense(`${SEED_YEAR}-09-16`, "40.00", "Targ Test", "groceries");
  return h;
}
