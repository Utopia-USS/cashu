// TRANSITIONAL(S44): the companion demo, built on the first launch until pairing brings the owner's
// real vaults to the phone. Two SYNTHETIC profiles in two vaults (rule 7: never the same row in
// both): `demo-anna` (budget, assets, investments) and `demo-home` (budget, assets, loans), 36
// months of history ending today. Every name, IBAN, merchant and amount is invented (IBANs are
// mostly zeros with a valid checksum, so own transfers match by IBAN). Built by running the real
// store commands (statement imports as Open Banking batches, cash expenses, rules, balances, assets,
// the loan, the strategy, Anna's portfolio in `companionInvestments.ts`), so the view is what the
// engine derives, never written by hand.
// Deterministic: seeded PRNG, seeded ULID randomness and a clock that follows the history (a row's
// command runs at its date 12:00 local, a month's import batch on the 1st of the next month 06:40,
// the newest batch today 06:40), relative to `today`. Runtime free: the caller opens the store.
import { D, type IsoDate } from "@cashu/domain";
import { merchantKey, type RawTransaction } from "@cashu/domain/budget";
// Type only (erased from the bundle): no narrow entry exports the command type.
import type { Command } from "@cashu/store";
import { addManualPosition, setVehicle } from "@cashu/store/assets/commands";
import {
  addCashExpense,
  cacheLlmRules,
  importStatement,
  matchTransfersCommand,
  setMerchantCategory,
  setTransactionCategory,
} from "@cashu/store/budget/commands";
import { createProfile, openAccount, recordBalance } from "@cashu/store/core/commands";
import { type VaultSalt, vaultSalt } from "@cashu/store/gid";
import type { SqlPriceCache } from "@cashu/store/investments/local";
import { saveStrategyVersion } from "@cashu/store/investments/strategy";
import { addLoan, setPaymentMatching } from "@cashu/store/loans/commands";
import {
  type CommandEnv,
  type CommandResult,
  HybridClock,
  runCommand,
  type Store,
  storeWriter,
} from "@cashu/store/runtime";
import { SCAFFOLD_DEVICE } from "../services/device";
import {
  companionStrategy,
  planAnnaInvestments,
  seedCompanionPrices,
} from "./companionInvestments";

export interface CompanionVaultSpec {
  readonly vault: string;
  readonly salt: VaultSalt;
  readonly slug: string;
  readonly name: string;
}

const salt = (seed: number) =>
  vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + seed) & 0xff));

/** The two demo vaults (ids and salts fixed: real ones are random and live in the keyring). */
export const COMPANION_VAULTS: {
  readonly anna: CompanionVaultSpec;
  readonly home: CompanionVaultSpec;
} = {
  anna: {
    vault: "ca000000000000000000000000000a11",
    salt: salt(7),
    slug: "demo-anna",
    name: "Anna",
  },
  home: {
    vault: "ca000000000000000000000000000b22",
    salt: salt(13),
    slug: "demo-home",
    name: "Home",
  },
};

export interface CompanionBuild {
  readonly vault: string;
  /** Events in the vault's log after the build. */
  readonly events: number;
  /** Rows of the `transactions` view after the build. */
  readonly transactions: number;
  /** Months of history (today's month included). */
  readonly months: number;
  /** Build time (ms, by the caller's clock). */
  readonly ms: number;
}

const MONTHS = 36;

// ------------------------------------------------------------------------------- generation

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date): IsoDate =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso: IsoDate) =>
  new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
/** Local wall time of `iso` at `hour`:`minute` (ms). */
const at = (iso: IsoDate, hour: number, minute = 0) => {
  const d = dateOf(iso);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};
/** The same calendar day `months` months from `iso` (clamped to the month's last day). */
function shiftMonths(iso: IsoDate, months: number): IsoDate {
  const d = dateOf(iso);
  const first = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return isoOf(new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last)));
}
/** Grosze (cents) as decimal text. */
const money = (cents: number) =>
  `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${pad(Math.abs(cents) % 100)}`;

/** A Polish IBAN with a valid checksum around an obviously fake, mostly zero account number. */
function fakeIban(bank: string, account: number): string {
  const bban = `${bank.padEnd(8, "0")}${String(account).padStart(16, "0")}`;
  const check = 98n - (BigInt(`${bban}252100`) % 97n);
  return `PL${pad(Number(check))}${bban}`;
}

const IBAN = {
  annaPersonal: fakeIban("11400000", 101),
  annaSavings: fakeIban("11400000", 102),
  annaEuro: fakeIban("12400000", 103),
  homeJoint: fakeIban("12400000", 201),
  homeSavings: fakeIban("12400000", 202),
  piotr: fakeIban("10200000", 301),
  lender: fakeIban("16000000", 401),
  employer: fakeIban("10500000", 501),
  cooperative: fakeIban("10900000", 601),
  insurer: fakeIban("10300000", 602),
  community: fakeIban("10900000", 603),
  preschool: fakeIban("10900000", 608),
  clinic: fakeIban("10200000", 609),
  brokerage: fakeIban("18700000", 610),
  carInsurer: fakeIban("10300000", 611),
  phone: fakeIban("10200000", 612),
  nursery: fakeIban("10900000", 613),
  cable: fakeIban("10200000", 614),
  homeInsurer: fakeIban("10300000", 615),
} as const;

/** One month of the history: its first day, its last day in the history and whether it is today's. */
interface Month {
  readonly index: number;
  readonly start: IsoDate;
  /** The month's last day, or today for today's month. */
  readonly end: IsoDate;
  readonly current: boolean;
}

function months(today: IsoDate): Month[] {
  const t = dateOf(today);
  return Array.from({ length: MONTHS }, (_, i) => {
    const first = new Date(t.getFullYear(), t.getMonth() - (MONTHS - 1) + i, 1);
    const current = i === MONTHS - 1;
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    return { index: i, start: isoOf(first), end: current ? today : isoOf(last), current };
  });
}
const onDay = (m: Month, day: number): IsoDate => `${m.start.slice(0, 8)}${pad(day)}`;

interface Row {
  readonly date: IsoDate;
  readonly cents: number;
  readonly counterparty: string;
  readonly title: string;
  readonly description: string;
  readonly iban: string | null;
  /** Unique per vault (`bank_transaction_id`), so a step can find its own row. */
  readonly id: string;
}

interface CashExpense {
  readonly date: IsoDate;
  readonly cents: number;
  readonly title: string;
  readonly category: string;
}

interface AccountPlan {
  readonly key: string;
  readonly bank: string;
  readonly name: string;
  readonly type: "checking" | "savings";
  readonly currency: "PLN" | "EUR";
  readonly iban: string;
  /** The balance today (cents); the opening balance is derived from the rows. */
  readonly closing: number;
  readonly rows: Row[];
}

/** Rows of one account up to `today`, with a row builder that numbers them. */
function account(plan: Omit<AccountPlan, "rows">, tag: string, today: IsoDate) {
  const rows: Row[] = [];
  const add = (
    date: IsoDate,
    cents: number,
    counterparty: string,
    options: { title?: string; description?: string; iban?: string | null } = {},
  ) => {
    if (date > today) return;
    rows.push({
      date,
      cents,
      counterparty,
      title: options.title ?? counterparty,
      description: options.description ?? (options.iban ? "PRZELEW" : "ZAKUP PRZY UZYCIU KARTY"),
      iban: options.iban ?? null,
      id: `CMP-${tag}-${rows.length + 1}`,
    });
  };
  return { plan: { ...plan, rows } as AccountPlan, add };
}

interface VaultPlan {
  readonly spec: CompanionVaultSpec;
  readonly modules: readonly string[];
  readonly accounts: readonly AccountPlan[];
  readonly cash: readonly CashExpense[];
  /** Owner pins (locked manual merchant rules): merchant -> category. */
  readonly pins: readonly (readonly [string, string])[];
  /** Cached classifier answers (unlocked llm rules): merchant -> category. */
  readonly llm: readonly (readonly [string, string])[];
  /** Bank rows the owner marked as a cash withdrawal (`bank_transaction_id`). */
  readonly withdrawals: readonly string[];
}

const between = (rand: () => number, low: number, high: number) =>
  Math.round(low + rand() * (high - low));
const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;

/** Today's-month rows only up to today; this day of the month or today, whichever is earlier. */
const until = (m: Month, day: number): IsoDate =>
  onDay(m, Math.min(day, Number(m.end.slice(8, 10))));

function annaPlan(today: IsoDate): VaultPlan {
  const rand = prng(0x0a11a);
  const more = prng(0x0a11b);
  const personal = account(
    {
      key: "personal",
      bank: "mbank",
      name: "mBank Personal",
      type: "checking",
      currency: "PLN",
      iban: IBAN.annaPersonal,
      closing: 940_000,
    },
    "AP",
    today,
  );
  const savings = account(
    {
      key: "savings",
      bank: "mbank",
      name: "mBank Savings",
      type: "savings",
      currency: "PLN",
      iban: IBAN.annaSavings,
      closing: 5_200_000,
    },
    "AS",
    today,
  );
  const euro = account(
    {
      key: "euro",
      bank: "pekao",
      name: "Pekao Euro",
      type: "checking",
      currency: "EUR",
      iban: IBAN.annaEuro,
      closing: 124_000,
    },
    "AE",
    today,
  );
  const cash: CashExpense[] = [];
  const withdrawals: string[] = [];
  const t = dateOf(today);
  // The yearly car insurance on 14 March: this year's when it is already due, else a year back.
  const insuranceYear =
    isoOf(new Date(t.getFullYear(), 2, 14)) <= today ? t.getFullYear() : t.getFullYear() - 1;
  const insurance = new Map([
    [insuranceYear - 2, 110_200],
    [insuranceYear - 1, 119_000],
    [insuranceYear, 128_400],
  ]);
  const all = months(today);
  // Cash: every month withdraws 300 and spends it; the first month spends `residue` less, so the
  // wallet holds 320.00 today whatever part of today's month has passed.
  const currentCash: CashExpense[] = [];
  for (const m of all) {
    const p = personal.add;
    p(onDay(m, 1), -14_900, "FITNESS KLUB DEMO");
    p(onDay(m, 2), -235_000, "SPOLDZIELNIA MIESZKANIOWA DEMO", {
      title: "OPLATA ZA LOKAL",
      iban: IBAN.cooperative,
    });
    p(until(m, 4), -30_000, "WYPLATA BANKOMAT", { description: "WYPLATA Z BANKOMATU" });
    withdrawals.push(`CMP-AP-${personal.plan.rows.length}`);
    p(onDay(m, 10), 1_480_000, "Northwind", {
      title: "NORTHWIND SP. Z O.O.",
      description: `WYNAGRODZENIE ZA ${m.start.slice(5, 7)}/${m.start.slice(0, 4)}`,
      iban: IBAN.employer,
    });
    p(onDay(m, 11), -150_000, "mBank Savings", { title: "PRZELEW WLASNY", iban: IBAN.annaSavings });
    savings.add(onDay(m, 11), 150_000, "mBank Personal", {
      title: "PRZELEW WLASNY",
      iban: IBAN.annaPersonal,
    });
    // The price change example: 49.00 until last month, 60.00 from this month (shown by today).
    p(m.current ? until(m, 14) : onDay(m, 14), m.current ? -6_000 : -4_900, "NETFLIX.COM");
    p(onDay(m, 20), -2_399, "SPOTIFY");
    const premium = insurance.get(Number(m.start.slice(0, 4)));
    if (m.start.slice(5, 7) === "03" && premium !== undefined)
      p(onDay(m, 14), -premium, "WARTA S.A.", {
        title: "POLISA OC/AC TOYOTA DEMO",
        iban: IBAN.insurer,
      });
    for (let i = 0; i < 8; i++)
      p(
        onDay(m, between(rand, 1, 28)),
        -between(rand, 3_500, 18_000),
        pick(rand, ["BIEDRONKA", "LIDL", "ZABKA", "CARREFOUR"]),
      );
    for (let i = 0; i < 2; i++)
      p(onDay(m, between(rand, 1, 28)), -between(rand, 18_000, 26_000), "ORLEN");
    for (let i = 0; i < 2; i++)
      p(onDay(m, between(rand, 1, 28)), -between(rand, 4_000, 9_000), "PYSZNE.PL");
    p(onDay(m, between(rand, 1, 28)), -between(rand, 2_000, 9_000), "APTEKA DEMO");
    p(onDay(m, between(rand, 1, 28)), -between(rand, 12_000, 40_000), "ALLEGRO");
    p(onDay(m, between(rand, 24, 26)), -between(rand, 18_720, 22_880), "PGE", {
      title: "OPLATA ZA ENERGIE",
      iban: fakeIban("10200000", 604),
    });
    euro.add(onDay(m, between(rand, 1, 28)), -between(rand, 3_000, 9_000), "AMAZON.DE");
    if (m.index % 3 === 2)
      euro.add(onDay(m, between(rand, 1, 28)), -between(rand, 12_000, 30_000), "BOOKING.COM");
    else euro.add(onDay(m, between(rand, 1, 28)), -between(rand, 3_000, 9_000), "AMAZON.DE");
    // Family, car, health and leisure: their own PRNG stream, so the rows above keep their amounts.
    p(onDay(m, 3), -145_000, "PRZEDSZKOLE DEMO", {
      title: "CZESNE PRZEDSZKOLE",
      iban: IBAN.preschool,
    });
    p(onDay(m, 6), -35_000, "MEDICOVER", { title: "ABONAMENT MEDYCZNY", iban: IBAN.clinic });
    p(onDay(m, 11), -100_000, "DOM MAKLERSKI DEMO", {
      title: "PRZELEW NA IKE",
      iban: IBAN.brokerage,
    });
    p(onDay(m, 12), -18_500, "PZU", { title: "RATA POLISY AUTO", iban: IBAN.carInsurer });
    p(onDay(m, 16), -6_500, "PLAY", { title: "ABONAMENT TELEFON", iban: IBAN.phone });
    p(onDay(m, between(more, 1, 28)), -between(more, 28_000, 42_000), "ZALANDO");
    for (let i = 0; i < 2; i++)
      p(onDay(m, between(more, 1, 28)), -between(more, 9_000, 18_000), "RESTAURACJA DEMO");
    for (let i = 0; i < 3; i++)
      p(onDay(m, between(more, 1, 28)), -between(more, 2_000, 4_500), "UBER");
    if (m.index % 2 === 1)
      p(onDay(m, between(more, 1, 28)), -between(more, 15_000, 40_000), "DECATHLON");
    p(onDay(m, between(more, 1, 28)), -between(more, 18_000, 26_000), "ORLEN");
    for (let i = 0; i < 4; i++)
      p(
        onDay(m, between(more, 1, 28)),
        -between(more, 6_000, 20_000),
        pick(more, ["BIEDRONKA", "LIDL", "ZABKA", "CARREFOUR"]),
      );
    p(onDay(m, between(more, 1, 28)), -between(more, 4_000, 12_000), "EMPIK");

    const farmers = { date: onDay(m, between(rand, 2, 27)), cents: between(rand, 2_500, 6_000) };
    const coffee = { date: onDay(m, between(rand, 2, 27)), cents: between(rand, 1_200, 2_500) };
    const taxiDay = onDay(m, between(rand, 2, 27));
    const taxiFare = between(rand, 3_000, 8_000);
    if (m.current) {
      // Today's month: only what already happened (before today).
      for (const [e, title, category] of [
        [farmers, "Farmers market", "groceries"],
        [coffee, "Coffee", "dining"],
        [{ date: taxiDay, cents: taxiFare }, "Taxi", "transport"],
      ] as const)
        if (e.date < today) currentCash.push({ date: e.date, cents: e.cents, title, category });
    } else {
      cash.push({ ...farmers, title: "Farmers market", category: "groceries" });
      cash.push({ ...coffee, title: "Coffee", category: "dining" });
      cash.push({
        date: taxiDay,
        cents: 30_000 - farmers.cents - coffee.cents,
        title: "Taxi",
        category: "transport",
      });
    }
    if (m.current) {
      // Merchants no seed rule knows: uncategorized until the owner (or the classifier) decides.
      p(until(m, 2), -8_600, "ZIELONY KRAM DEMO");
      p(until(m, 3), -12_000, "SKLEP ROWEROWY DEMO");
      p(until(m, 5), -4_500, "KWIATY POD MOSTEM DEMO");
      p(until(m, 6), -6_500, "GARMAZERKA DEMO");
      // Categorized by a cached classifier answer (llm rules below).
      p(until(m, 7), -34_000, "WARSZTAT DEMO");
      p(until(m, 8), -5_800, "ANTYKWARIAT DEMO");
      p(until(m, 9), -18_000, "GABINET MASAZU DEMO");
    }
  }
  const residue = 2_000 + currentCash.reduce((sum, e) => sum + e.cents, 0);
  const firstTaxi = cash.findIndex((e) => e.title === "Taxi");
  const taxi = cash[firstTaxi];
  if (taxi !== undefined) cash[firstTaxi] = { ...taxi, cents: taxi.cents - residue };
  cash.push(...currentCash);
  return {
    spec: COMPANION_VAULTS.anna,
    modules: ["budget", "assets", "investments"],
    accounts: [personal.plan, savings.plan, euro.plan],
    cash,
    // PLAY: no seed rule knows it; the IKE contribution moves money to the owner's own retirement
    // account, so it is a transfer (the taxonomy has no investments key), not spending.
    pins: [
      ["Northwind", "income_salary"],
      ["PLAY", "utilities"],
      ["DOM MAKLERSKI DEMO", "transfer"],
    ],
    llm: [
      ["WARSZTAT DEMO", "transport"],
      ["ANTYKWARIAT DEMO", "shopping"],
      ["GABINET MASAZU DEMO", "health"],
    ],
    withdrawals,
  };
}

function homePlan(today: IsoDate): VaultPlan {
  const rand = prng(0x0b22b);
  const more = prng(0x0b22c);
  const joint = account(
    {
      key: "joint",
      bank: "pekao",
      name: "Pekao Joint",
      type: "checking",
      currency: "PLN",
      iban: IBAN.homeJoint,
      closing: 610_000,
    },
    "HJ",
    today,
  );
  const savings = account(
    {
      key: "savings",
      bank: "pekao",
      name: "Home savings",
      type: "savings",
      currency: "PLN",
      iban: IBAN.homeSavings,
      closing: 2_800_000,
    },
    "HS",
    today,
  );
  for (const m of months(today)) {
    const j = joint.add;
    j(onDay(m, 1), 520_000, "PRZELEW OD ANNA", { iban: IBAN.annaPersonal });
    j(onDay(m, 1), 440_000, "PRZELEW OD PIOTR", { iban: IBAN.piotr });
    j(onDay(m, 2), -80_000, "Home savings", { title: "PRZELEW WLASNY", iban: IBAN.homeSavings });
    savings.add(onDay(m, 2), 80_000, "Pekao Joint", {
      title: "PRZELEW WLASNY",
      iban: IBAN.homeJoint,
    });
    j(onDay(m, 3), -68_000, "WSPOLNOTA DEMO", { title: "ZALICZKA CZYNSZ", iban: IBAN.community });
    j(onDay(m, 5), -243_118, "BANK HIPOTECZNY DEMO", {
      title: "RATA KREDYTU HIPOTECZNEGO",
      iban: IBAN.lender,
    });
    j(onDay(m, 8), -7_900, "UPC", { title: "INTERNET", iban: fakeIban("10200000", 605) });
    j(onDay(m, 15), -12_000, "PGNIG", { title: "OPLATA ZA GAZ", iban: fakeIban("10200000", 606) });
    // The partner example: 208.00 every month, 286.00 this month (shown by today).
    j(m.current ? until(m, 25) : onDay(m, 25), m.current ? -28_600 : -20_800, "PGE", {
      title: "OPLATA ZA ENERGIE",
      iban: fakeIban("10200000", 607),
    });
    for (let i = 0; i < 6; i++)
      j(
        onDay(m, between(rand, 1, 28)),
        -between(rand, 6_000, 22_000),
        pick(rand, ["BIEDRONKA", "LIDL", "AUCHAN"]),
      );
    if (m.index % 2 === 1)
      j(onDay(m, between(rand, 1, 28)), -between(rand, 30_000, 90_000), "IKEA");
    j(onDay(m, between(rand, 1, 28)), -between(rand, 2_000, 9_000), "APTEKA DEMO");
    j(onDay(m, between(rand, 1, 28)), -between(rand, 3_000, 12_000), "ROSSMANN");
    // Childcare, car, home and leisure: their own PRNG stream, so the rows above keep their amounts.
    j(onDay(m, 4), -110_000, "ZLOBEK DEMO", { title: "OPLATA ZLOBEK", iban: IBAN.nursery });
    j(onDay(m, 9), -6_900, "VECTRA", { title: "INTERNET TV", iban: IBAN.cable });
    j(onDay(m, 20), -9_500, "PZU", { title: "RATA POLISY DOM", iban: IBAN.homeInsurer });
    for (let i = 0; i < 2; i++)
      j(onDay(m, between(more, 1, 28)), -between(more, 20_000, 28_000), "ORLEN");
    if (m.index % 2 === 0)
      j(onDay(m, between(more, 1, 28)), -between(more, 20_000, 60_000), "CASTORAMA");
    j(onDay(m, between(more, 1, 28)), -between(more, 12_000, 22_000), "RESTAURACJA DEMO");
    for (let i = 0; i < 3; i++)
      j(
        onDay(m, between(more, 1, 28)),
        -between(more, 8_000, 22_000),
        pick(more, ["LIDL", "AUCHAN"]),
      );
    j(onDay(m, between(more, 1, 28)), -between(more, 2_000, 9_000), "APTEKA DEMO");
    if (m.current) {
      j(until(m, 4), -25_000, "HYDRAULIK DEMO");
      j(until(m, 6), -5_300, "SKLEP OGRODNICZY DEMO");
    }
  }
  return {
    spec: COMPANION_VAULTS.home,
    modules: ["budget", "assets", "loans"],
    accounts: [joint.plan, savings.plan],
    cash: [],
    pins: [
      ["PRZELEW OD ANNA", "income_other"],
      ["PRZELEW OD PIOTR", "income_other"],
    ],
    llm: [],
    withdrawals: [],
  };
}

// ------------------------------------------------------------------------------- build

/** One command run at a point of the history (ms, local wall clock). */
interface Step {
  readonly at: number;
  readonly run: () => void;
}

/** Seeded random bytes for ULIDs, so two builds mint the same gids. */
function seededBytes(seed: number): (n: number) => Uint8Array {
  let state = seed >>> 0;
  return (n) =>
    Uint8Array.from({ length: n }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state >>> 24;
    });
}

/** Bank accounts of each demo vault (`annaPlan` / `homePlan`). */
const BANK_ACCOUNTS = { anna: 3, home: 2 } as const;

/**
 * Whether `store` holds a finished build of `which`: its last steps record today's month's balances,
 * so every bank account holds one balance per month of the history, and (Anna) run the daily
 * evaluation of the portfolio. False for an empty vault and for a build that stopped halfway (a
 * refused command, the process killed during the first launch).
 */
export function companionVaultComplete(store: Store, which: "anna" | "home"): boolean {
  const rows = store.read<{ n: number }>(
    `SELECT COUNT(b.date) AS n FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
     WHERE a.type IN ('checking', 'savings') AND a.removed_at IS NULL GROUP BY a.id`,
  );
  if (rows.length !== BANK_ACCOUNTS[which] || !rows.every((r) => r.n >= MONTHS)) return false;
  // Anna's build ends with the daily evaluation (a vault built before the portfolio is rebuilt).
  return (
    which !== "anna" ||
    (store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_rule_runs")[0]?.n ?? 0) > 0
  );
}

/**
 * Build the demo vault `which` into an empty `store` (the caller opened it with the spec's vault and
 * salt). Throws on a refused command: the fixture is fixed data, a refusal is a bug.
 */
export function buildCompanionVault(
  store: Store,
  which: "anna" | "home",
  today: IsoDate,
  now: () => number,
): CompanionBuild {
  const t0 = now();
  const plan = which === "anna" ? annaPlan(today) : homePlan(today);
  let wall = 0;
  const clock = { now: () => wall };
  const env: CommandEnv = {
    device: SCAFFOLD_DEVICE,
    clock,
    hlc: new HybridClock(SCAFFOLD_DEVICE, { physical: clock }),
    // The fixture is this device's own first launch; nothing else holds the vault.
    lease: { isHolder: () => true },
    random: seededBytes(which === "anna" ? 0xa11 : 0xb22),
  };
  const writer = storeWriter(store);
  const apply = <I, R>(command: Command<I, R>, input: unknown): R => {
    const result: CommandResult<R> = runCommand(store, writer, command, input, env);
    if (!result.ok) throw new Error(`companion demo: ${command.id} refused (${result.reason})`);
    return result.value;
  };

  const all = months(today);
  const first = all[0] as Month;
  const steps: Step[] = [];
  const step = (time: number, run: () => void) => steps.push({ at: time, run });
  const start = at(first.start, 6);
  const gids = new Map<string, string>();

  step(start, () => {
    apply(createProfile, {
      slug: plan.spec.slug,
      name: plan.spec.name,
      baseCurrency: "PLN",
      modules: plan.modules,
    });
    for (const a of plan.accounts) {
      const opened = apply(openAccount, {
        bank: a.bank,
        name: a.name,
        type: a.type,
        currency: a.currency,
        iban: a.iban,
      });
      gids.set(a.key, opened.account);
    }
    for (const [merchant, category] of plan.pins)
      apply(setMerchantCategory, { merchantKey: merchant, category });
  });

  for (const e of plan.cash)
    step(at(e.date, 12), () =>
      apply(addCashExpense, {
        amount: money(e.cents),
        title: e.title,
        category: e.category,
        onDate: e.date,
      }),
    );

  const recordMonthEnd = (a: AccountPlan, m: Month) =>
    apply(recordBalance, {
      account: gids.get(a.key),
      date: m.end,
      source: "open_banking",
      amount: money(balanceAt(a, m.end)),
    });
  const withdrawals = new Set(plan.withdrawals);
  for (const m of all) {
    // A month's batch: the 1st of the next month 06:40, today's month today 06:40 (Open Banking).
    const fetchedAt = m.current ? at(today, 6, 40) : at(shiftMonths(m.start, 1), 6, 40);
    step(fetchedAt, () => {
      for (const a of plan.accounts) {
        const rows = a.rows.filter((r) => r.date >= m.start && r.date <= m.end);
        apply(importStatement, {
          account: gids.get(a.key),
          statement: statement(a, rows),
          source: "open_banking",
          filename: null,
        });
        for (const r of rows) {
          if (!withdrawals.has(r.id)) continue;
          const txn = store.read<{ gid: string }>(
            "SELECT gid FROM transactions WHERE bank_transaction_id = ?",
            r.id,
          )[0];
          if (txn === undefined) throw new Error(`companion demo: withdrawal ${r.id} not imported`);
          apply(setTransactionCategory, { txn: txn.gid, category: "cash_withdrawal" });
        }
        // Today's month's balances close the build (see `companionVaultComplete`).
        if (!m.current) recordMonthEnd(a, m);
      }
    });
  }

  const morning = at(today, 6, 41);
  step(morning, () => {
    if (plan.llm.length > 0)
      apply(cacheLlmRules, {
        items: plan.llm.map(([merchant, category]) => ({
          merchantKey: merchantKey(merchant),
          category,
        })),
      });
    // As the desktop demo: pair the own transfers once every statement is in.
    apply(matchTransfersCommand, {});
  });
  // The last step of every build: today's balances. A vault whose every bank account holds a balance
  // for each month of the history finished its build (the completion marker).
  const current = all[all.length - 1] as Month;
  step(at(today, 6, 42), () => {
    for (const a of plan.accounts) recordMonthEnd(a, current);
  });

  if (which === "anna") {
    // The car, valued last month on its depreciation curve.
    const valued = shiftMonths(today, -1);
    step(at(valued, 12), () =>
      apply(setVehicle, {
        name: "Toyota Demo",
        purchasePrice: "86000",
        purchaseDate: shiftMonths(today, -48),
        annualRate: "12",
        floor: "20000",
        asOf: valued,
      }),
    );
    // The passive starter with a weekly review and a PLN 2,500 monthly plan, then the portfolio.
    const strategy = companionStrategy();
    step(start, () =>
      apply(saveStrategyVersion, { yamlText: strategy.yaml, mdText: strategy.markdown }),
    );
    planAnnaInvestments({
      today,
      historyStart: first.start,
      apply,
      step,
      at,
      read: (sql, ...params) => store.read(sql, ...params),
    });
  } else {
    step(start, () => {
      const loan = apply(addLoan, {
        name: "Kredyt hipoteczny",
        type: "mortgage",
        principal: "420000",
        annualRate: "7.1",
        termMonths: 300,
        startDate: `${shiftMonths(today, -40).slice(0, 8)}05`,
      });
      apply(setPaymentMatching, {
        account: loan.account,
        iban: IBAN.lender,
        text: "RATA KREDYTU HIPOTECZNEGO",
      });
    });
    const valued = shiftMonths(today, -14);
    step(at(valued, 12), () =>
      apply(addManualPosition, {
        name: "Mieszkanie Demo",
        type: "property",
        value: "780000",
        onDate: valued,
      }),
    );
  }

  // Stable: steps at the same instant run in the order they were planned.
  const ordered = steps.map((s, i) => ({ ...s, i })).sort((a, b) => a.at - b.at || a.i - b.i);
  for (const s of ordered) {
    wall = s.at;
    s.run();
  }

  const count = (sql: string) => store.read<{ n: number }>(sql)[0]?.n ?? 0;
  return {
    vault: plan.spec.vault,
    events: count("SELECT COUNT(*) AS n FROM event_log"),
    transactions: count("SELECT COUNT(*) AS n FROM transactions"),
    months: all.length,
    ms: now() - t0,
  };
}

/**
 * Anna's demo prices and NBP rates into this device's price cache: called after her vault was built on
 * this launch (the series follows the same `today` as the build).
 */
export function seedCompanionDemoPrices(prices: SqlPriceCache, today: IsoDate): void {
  seedCompanionPrices(prices, today, (months(today)[0] as Month).start);
}

/** The account's balance at the end of `day` (cents): today's closing minus every later row. */
function balanceAt(a: AccountPlan, day: IsoDate): number {
  return a.rows.reduce((balance, r) => (r.date > day ? balance - r.cents : balance), a.closing);
}

/** A parsed statement of one account's rows (oldest first); balances are recorded separately. */
function statement(a: AccountPlan, rows: readonly Row[]) {
  const sorted = [...rows].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const transactions: RawTransaction[] = sorted.map((r) => ({
    bookingDate: r.date,
    valueDate: r.date,
    amount: D(money(r.cents)),
    currency: a.currency,
    counterpartyName: r.counterparty,
    counterpartyIban: r.iban,
    description: r.description,
    reference: r.title,
    bankTransactionId: r.id,
    source: "open_banking",
    raw: { id: r.id },
  }));
  return {
    bank: a.bank,
    accountNumber: a.iban,
    accountName: a.name,
    currency: a.currency,
    transactions,
    balances: [],
    closingBalances: [],
  };
}
