// A SYNTHETIC, demo-like event log for the debug build: one vault ("demo"), four bank accounts in two
// currencies, a year of transactions, merchant rules, month-end balances, re-imported duplicates and
// a few investment decisions. Deterministic (seeded PRNG, fixed clock), so the same log builds the
// same view on every runtime: the device's view hash (expo-sqlite) is compared with the Node one
// (better-sqlite3) at the same commit. No real names, IBANs or amounts.
import { detGid, mintUlid, vaultSalt } from "@cashu/store/gid";
import { v1 } from "@cashu/store/runtime";

/** The demo vault id (32 lower hex). Real vault ids are random. */
export const DEMO_VAULT = "de000000000000000000000000000041";
/** A fixed demo salt. Real salts are random and live in the keyring. */
export const DEMO_SALT = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const DEVICE = "d1000000000000000000000000000041";
/** 2025-11-01T08:00:00Z: the log starts here and moves forward one second per event. */
const START = 1_761_984_000_000;

export interface DemoEnvelope {
  eid: string;
  vault: string;
  device: string;
  hlc: string;
  at: string;
  type: string;
  v: number;
  gid: string;
  data: Record<string, unknown>;
}

/** mulberry32: a small seeded PRNG, enough for synthetic data. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS: readonly { name: string; category: string; min: number; max: number }[] = [
  { name: "SKLEP OSIEDLOWY 01", category: "groceries", min: 8, max: 120 },
  { name: "SKLEP OSIEDLOWY 02", category: "groceries", min: 8, max: 120 },
  { name: "HIPERMARKET PRZYKLAD", category: "groceries", min: 40, max: 420 },
  { name: "PIEKARNIA TESTOWA", category: "groceries", min: 4, max: 40 },
  { name: "STACJA PALIW DEMO", category: "fuel", min: 90, max: 380 },
  { name: "STACJA PALIW WZOR", category: "fuel", min: 90, max: 380 },
  { name: "APTEKA PRZYKLADOWA", category: "health", min: 12, max: 160 },
  { name: "KAWIARNIA FIKCYJNA", category: "eating_out", min: 9, max: 45 },
  { name: "BISTRO SYNTETYCZNE", category: "eating_out", min: 25, max: 140 },
  { name: "PIZZERIA DEMO", category: "eating_out", min: 30, max: 120 },
  { name: "KINO PRZYKLAD", category: "entertainment", min: 20, max: 90 },
  { name: "KSIEGARNIA TESTOWA", category: "entertainment", min: 25, max: 150 },
  { name: "SIEC KOMORKOWA DEMO", category: "bills", min: 45, max: 90 },
  { name: "DOSTAWCA PRADU DEMO", category: "bills", min: 120, max: 380 },
  { name: "INTERNET WZOR", category: "bills", min: 60, max: 80 },
  { name: "TRANSPORT MIEJSKI", category: "transport", min: 4, max: 120 },
  { name: "PRZEWOZNIK KOLEJOWY", category: "transport", min: 25, max: 220 },
  { name: "SKLEP ODZIEZOWY TEST", category: "shopping", min: 60, max: 480 },
  { name: "SKLEP RTV PRZYKLAD", category: "shopping", min: 80, max: 1800 },
  { name: "MARKET BUDOWLANY DEMO", category: "home", min: 30, max: 900 },
  { name: "SERWIS STREAMINGOWY", category: "subscriptions", min: 29, max: 60 },
  { name: "SILOWNIA FIKCYJNA", category: "subscriptions", min: 99, max: 159 },
  { name: "WETERYNARZ TESTOWY", category: "health", min: 80, max: 400 },
  { name: "PRALNIA WZOR", category: "home", min: 20, max: 80 },
];

const ACCOUNTS = [
  { n: 1, bank: "mbank", type: "checking", currency: "PLN", name: "Konto osobiste (demo)" },
  { n: 2, bank: "mbank", type: "savings", currency: "PLN", name: "Oszczednosci (demo)" },
  { n: 3, bank: "pekao", type: "checking", currency: "PLN", name: "Konto wspolne (demo)" },
  { n: 4, bank: "erste", type: "checking", currency: "EUR", name: "Konto EUR (demo)" },
] as const;

const MONTHS = 12;
const SPEND_PER_MONTH = 190;
const DUPLICATES = 80;
const DECISIONS = 24;

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Month `m` (0 = 2025-11) and day as an ISO date. */
function isoDate(m: number, day: number): string {
  const year = 2025 + Math.floor((10 + m) / 12);
  const month = ((10 + m) % 12) + 1;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
const money = (cents: number) =>
  `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${pad2(Math.abs(cents) % 100)}`;

/** The demo log, in emission order. ~2.6k events. */
export function demoLog(): DemoEnvelope[] {
  const r = prng(41);
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
  const hex = (n: number) => Array.from(bytes(n), (b) => b.toString(16).padStart(2, "0")).join("");
  const events: DemoEnvelope[] = [];
  let wall = START;
  const emit = (type: string, gid: string, data: Record<string, unknown>): DemoEnvelope => {
    wall += 1000;
    const e: DemoEnvelope = {
      eid: mintUlid(wall, bytes),
      vault: DEMO_VAULT,
      device: DEVICE,
      hlc: v1.formatHlc({ wall, counter: 0, device: DEVICE }),
      at: new Date(wall).toISOString(),
      type,
      v: 1,
      gid,
      data,
    };
    events.push(e);
    return e;
  };

  emit("profile.created", DEMO_VAULT, {
    slug: "demo",
    name: "Demo",
    baseCurrency: "PLN",
    mcpPrivacy: "strict",
  });
  for (const moduleId of ["budget", "investments"]) {
    emit("module.enabled", detGid(DEMO_SALT, "profile_modules", [moduleId]), { moduleId });
  }
  const accounts = ACCOUNTS.map((a) => {
    const externalId = `demo-${a.n}`;
    const gid = detGid(DEMO_SALT, "accounts", ["ext", a.bank, externalId]);
    emit("account.opened", gid, {
      bank: a.bank,
      externalId,
      iban: null,
      currency: a.currency,
      type: a.type,
      name: a.name,
      keys: [`ext:${a.bank}:${externalId}`],
    });
    return { ...a, gid, balance: 0 };
  });
  for (const m of MERCHANTS) {
    emit("categoryRule.set", detGid(DEMO_SALT, "category_rules", [m.name]), {
      merchantKey: m.name,
      category: m.category,
      source: "manual",
      locked: false,
    });
  }

  const imports: DemoEnvelope[] = [];
  const txn = (
    account: (typeof accounts)[number],
    date: string,
    cents: number,
    counterpartyName: string,
    description: string,
  ) => {
    const dedupHash = hex(20);
    const e = emit(
      "txn.imported",
      detGid(DEMO_SALT, "transactions", [account.gid, dedupHash, "0"]),
      {
        account: account.gid,
        batch: null,
        bookingDate: date,
        valueDate: null,
        amount: money(cents),
        currency: account.currency,
        counterpartyName,
        counterpartyIban: null,
        description,
        reference: null,
        bankTransactionId: null,
        source: "csv",
        dedupHash,
        occurrence: 0,
        raw: {},
      },
    );
    account.balance += cents;
    imports.push(e);
  };

  const [main, savings, joint, eur] = accounts as [
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
  ];
  for (let m = 0; m < MONTHS; m++) {
    txn(
      main,
      isoDate(m, 1),
      1_650_000 + Math.floor(r() * 40_000),
      "PRACODAWCA DEMO",
      "wynagrodzenie",
    );
    txn(joint, isoDate(m, 2), -280_000, "WYNAJEM DEMO", "czynsz");
    txn(main, isoDate(m, 3), -150_000, "PRZELEW WLASNY", "oszczednosci");
    txn(savings, isoDate(m, 3), 150_000, "PRZELEW WLASNY", "oszczednosci");
    txn(eur, isoDate(m, 5), -Math.floor(2_000 + r() * 30_000), "SKLEP INTERNETOWY EU", "zakup");
    for (let i = 0; i < SPEND_PER_MONTH; i++) {
      const merchant = MERCHANTS[Math.floor(r() * MERCHANTS.length)] as (typeof MERCHANTS)[number];
      const cents = -Math.round((merchant.min + r() * (merchant.max - merchant.min)) * 100);
      const account = r() < 0.55 ? main : joint;
      txn(account, isoDate(m, 1 + Math.floor(r() * 28)), cents, merchant.name, "platnosc karta");
    }
    for (const a of accounts) {
      const date = isoDate(m, 28);
      emit("balance.recorded", detGid(DEMO_SALT, "balances", [a.gid, date, "csv"]), {
        account: a.gid,
        date,
        source: "csv",
        amount: money(a.balance + 5_000_000),
        currency: a.currency,
      });
    }
  }
  // Overlapping exports: the same facts (same DET gid) again under new eids, a no-op for the view.
  for (let n = 0; n < DUPLICATES; n++) {
    const orig = imports[Math.floor(r() * imports.length)] as DemoEnvelope;
    wall += 1000;
    events.push({
      ...orig,
      eid: mintUlid(wall, bytes),
      hlc: v1.formatHlc({ wall, counter: 0, device: DEVICE }),
      at: new Date(wall).toISOString(),
    });
  }
  // The owner changed their mind about a few merchants (rule edits, last writer wins).
  for (const m of MERCHANTS.slice(0, 6)) {
    emit("categoryRule.set", detGid(DEMO_SALT, "category_rules", [m.name]), {
      merchantKey: m.name,
      category: "other",
      source: "manual",
      locked: true,
    });
  }
  for (let n = 0; n < DECISIONS; n++) {
    emit("decision.recorded", mintUlid(wall + 1, bytes), {
      signals: [],
      instrument: null,
      account: null,
      action: n % 3 === 0 ? "bought" : "held",
      quantity: null,
      price: null,
      currency: null,
      reason: null,
    });
  }
  return events;
}
