/** Python rules/support and shared metric input messages, preserved in both UI languages. */
export const supportStrings = {
  days: {
    pl: (days: number) => (days === 1 ? "1 dzień" : `${days} dni`),
    en: (days: number) => `${days} ${days === 1 ? "day" : "days"}`,
  },
  bucket: { pl: "Koszyk", en: "Bucket" },
  ofBucket: { pl: "koszyka", en: "the bucket" },
  onAccount: { pl: "na koncie", en: "in account" },
  conjunction: { pl: " i ", en: " and " },
  affectedHoldings: {
    pl: (count: number, names: string) => `${count} pozycji (${names})`,
    en: (count: number, names: string) =>
      `${count} ${count === 1 ? "position" : "positions"} (${names})`,
  },
  affectedCash: {
    pl: (count: number) => `${count} ${count === 1 ? "salda" : "sald"} gotówki`,
    en: (count: number) => `${count} ${count === 1 ? "cash balance" : "cash balances"}`,
  },
  noValue: { pl: "Portfel nie ma jeszcze wartości", en: "The portfolio has no value yet" },
  noAllocations: { pl: "Brak wyliczonej alokacji koszyków", en: "No bucket allocation computed" },
  noPlan: { pl: "Strategia nie ma planu wpłat", en: "The strategy has no contributions plan" },
  missingPrices: {
    pl: (count: number, names: string) =>
      `Brak ceny dla ${count} pozycji (${names}): wagi portfela niepełne`,
    en: (count: number, names: string) =>
      `No price for ${count} ${count === 1 ? "position" : "positions"} (${names}): portfolio weights incomplete`,
  },
  staleShare: {
    pl: (share: string, maximum: string) =>
      `Nieaktualne ceny: ${share} portfela (maks. ${maximum})`,
    en: (share: string, maximum: string) =>
      `Stale prices: ${share} of the portfolio (max ${maximum})`,
  },
  unclassified: {
    pl: (share: string, maximum: string, names: string) =>
      `Pozycje bez koszyka: ${share} portfela (maks. ${maximum}): ${names}; sklasyfikuj je lub otaguj, by trafiły do koszyka`,
    en: (share: string, maximum: string, names: string) =>
      `Positions without a bucket: ${share} of the portfolio (max ${maximum}): ${names}; classify or tag them to put them in a bucket`,
  },
  noAllocation: {
    pl: (bucket: string) => `Brak alokacji ${bucket}`,
    en: (bucket: string) => `No allocation for ${bucket}`,
  },
  bucketCashGap: {
    pl: (bucket: string) =>
      `${bucket}: ujemna gotówka (brak wpłat w zaimportowanej historii), wartość nieznana`,
    en: (bucket: string) =>
      `${bucket}: negative cash (contributions missing from the imported history), value unknown`,
  },
  cashHistory: {
    pl: (listed: string) =>
      `Niepełna historia gotówki (ujemne saldo: ${listed}; brak wpłat w zaimportowanej historii?): udział gotówki nieznany`,
    en: (listed: string) =>
      `Incomplete cash history (negative balance: ${listed}; contributions missing from the imported history?): cash share unknown`,
  },
  manualSeries: {
    pl: (label: string) => `${label}: wycena ręczna, brak notowań rynkowych`,
    en: (label: string) => `${label}: valued manually, no market prices`,
  },
  costSeries: {
    pl: (label: string) => `${label}: wycena po koszcie, brak notowań rynkowych`,
    en: (label: string) => `${label}: valued at cost, no market prices`,
  },
  manualResult: {
    pl: (label: string) => `${label}: wycena ręczna, zmiana od kosztu nie jest wynikiem rynkowym`,
    en: (label: string) => `${label}: valued manually, the change from cost is not a market result`,
  },
  noRate: {
    pl: (currency: string, label: string) => `Brak kursu ${currency}: nie da się wycenić ${label}`,
    en: (currency: string, label: string) => `No ${currency} rate: cannot value ${label}`,
  },
  noPrice: {
    pl: (label: string) => `Brak ceny: ${label}`,
    en: (label: string) => `No price: ${label}`,
  },
  stalePrice: {
    pl: (label: string) => `Nieaktualna cena: ${label}`,
    en: (label: string) => `Stale price: ${label}`,
  },
  staleDated: {
    pl: (label: string, date: string) => `Nieaktualna cena: ${label} (ostatnie zamknięcie ${date})`,
    en: (label: string, date: string) => `Stale price: ${label} (last close ${date})`,
  },
  zeroCost: {
    pl: (label: string) => `Zerowy koszt: ${label}`,
    en: (label: string) => `Zero cost: ${label}`,
  },
  unknownCost: {
    pl: (label: string) => `Nieznany koszt: ${label} (niepełna historia lub transfer bez ceny)`,
    en: (label: string) =>
      `Unknown cost: ${label} (incomplete history or a transfer without a price)`,
  },
  staleClose: {
    pl: (label: string, date: string, days: string) =>
      `Nieaktualna cena: ${label} (ostatnie zamknięcie ${date}, ${days} temu)`,
    en: (label: string, date: string, days: string) =>
      `Stale price: ${label} (last close ${date}, ${days} ago)`,
  },
  shortSeries: {
    pl: (label: string, stored: number, needed: number) =>
      `Tylko ${stored} z ${needed} notowań: ${label}`,
    en: (label: string, stored: number, needed: number) =>
      `Only ${stored} of ${needed} closes: ${label}`,
  },
  noSeries: {
    pl: (label: string) => `Brak notowań: ${label}`,
    en: (label: string) => `No prices: ${label}`,
  },
  invalidPrices: {
    pl: (label: string) => `Nieprawidłowe ceny: ${label}`,
    en: (label: string) => `Invalid prices: ${label}`,
  },
  missingFx: {
    pl: (names: string, base: string, date: string, maxAge: string, affected: string) =>
      `Brak kursu ${names}/${base} na ${date} (brak lub starszy niż ${maxAge}): nie da się wycenić ${affected || "części kwot"}; wagi portfela niepełne`,
    en: (names: string, base: string, date: string, maxAge: string, affected: string) =>
      `No ${names}/${base} rate on ${date} (missing or older than ${maxAge}): cannot value ${affected || "some amounts"}; portfolio weights incomplete`,
  },
} as const;
