/** Owner-visible alert evaluation text; PL/EN are explicit per evaluation request. */
const STATUS_PL: Readonly<Record<string, string>> = {
  delisted: "wycofany z obrotu",
  frozen: "zamrożony",
};
export const alertStrings = {
  bucketOf: { pl: "koszyka", en: "the bucket" },
  noInstrument: { pl: "Alert nie ma instrumentu", en: "The alert has no instrument" },
  notValued: { pl: "Nie udało się wycenić portfela", en: "The portfolio could not be valued" },
  noPrices: {
    pl: (s: string) => `Brak cen: ${s} (zostaną pobrane przy codziennym uruchomieniu)`,
    en: (s: string) => `No prices: ${s} (the daily run will fetch them)`,
  },
  status: {
    pl: (s: string, status: string) =>
      `${s}: ${STATUS_PL[status] ?? status}, brak bieżących notowań`,
    en: (s: string, status: string) => `${s}: ${status}, no current prices`,
  },
  invalidPrices: {
    pl: (s: string) => `Nieprawidłowe ceny w okresie: ${s}`,
    en: (s: string) => `Invalid prices in the window: ${s}`,
  },
  noVolume: {
    pl: (s: string) => `Brak wolumenu w okresie: ${s} (źródło cen go nie podaje)`,
    en: (s: string) => `No volume in the window: ${s} (the price source does not provide it)`,
  },
  zeroVolume: {
    pl: (s: string) => `Zerowy średni wolumen w okresie: ${s}`,
    en: (s: string) => `Zero average volume in the window: ${s}`,
  },
  noWeight: { pl: (s: string) => `Brak wagi: ${s}`, en: (s: string) => `No weight: ${s}` },
  allocationSuffix: { pl: "(czy jest w strategii?)", en: "(is it in the strategy?)" },
  bucketGap: {
    pl: (s: string) => `Niepełna historia gotówki: wartość ${s} nieznana`,
    en: (s: string) => `Incomplete cash history: value of ${s} unknown`,
  },
  just: { pl: "tuż", en: "just" },
  price: {
    pl: (s: string, close: string, cur: string, date: string, above: boolean, level: string) =>
      `${s}: zamknięcie ${close} ${cur} (${date}), ${above ? "powyżej" : "poniżej"} ${level} ${cur}.`,
    en: (s: string, close: string, cur: string, date: string, above: boolean, level: string) =>
      `${s}: close ${close} ${cur} (${date}), ${above ? "above" : "below"} ${level} ${cur}.`,
  },
  change: {
    pl: (
      s: string,
      size: string,
      n: number,
      first: string,
      from: string,
      last: string,
      date: string,
    ) => `${s}: ${size} w ciągu ${n} sesji (${first} ${from} -> ${last} ${date}).`,
    en: (
      s: string,
      size: string,
      n: number,
      first: string,
      from: string,
      last: string,
      date: string,
    ) =>
      `${s}: ${size} in ${n} ${n === 1 ? "session" : "sessions"} (${first} ${from} -> ${last} ${date}).`,
  },
  drawdown: {
    pl: (
      s: string,
      size: string,
      n: number,
      last: string,
      date: string,
      high: string,
      highDate: string,
    ) =>
      `${s}: -${size} od szczytu z ${n} sesji (zamknięcie ${last} ${date}, szczyt ${high} ${highDate}).`,
    en: (
      s: string,
      size: string,
      n: number,
      last: string,
      date: string,
      high: string,
      highDate: string,
    ) =>
      `${s}: -${size} from the ${n}-session high (close ${last} ${date}, high ${high} ${highDate}).`,
  },
  high: {
    pl: (s: string, n: number, last: string, date: string, previous: string) =>
      `${s}: nowy szczyt z ${n} sesji, ${last} (${date}; poprzedni ${previous}).`,
    en: (s: string, n: number, last: string, date: string, previous: string) =>
      `${s}: new ${n}-session high, ${last} (${date}; previous ${previous}).`,
  },
  sma: {
    pl: (s: string, last: string, date: string, above: boolean, n: number, sma: string) =>
      `${s}: zamknięcie ${last} (${date}) ${above ? "powyżej" : "poniżej"} SMA ${n} (${sma}).`,
    en: (s: string, last: string, date: string, above: boolean, n: number, sma: string) =>
      `${s}: close ${last} (${date}) ${above ? "above" : "below"} SMA ${n} (${sma}).`,
  },
  breakout: {
    pl: (
      s: string,
      n: number,
      size: string,
      up: boolean,
      edge: string,
      cur: string,
      last: string,
      date: string,
    ) =>
      `${s}: wybicie z konsolidacji ${n} sesji, ${size} ${up ? "nad" : "pod"} ${edge} ${cur} (zamknięcie ${last} ${cur}, ${date}).`,
    en: (
      s: string,
      n: number,
      size: string,
      up: boolean,
      edge: string,
      cur: string,
      last: string,
      date: string,
    ) =>
      `${s}: breakout from a ${n}-session range, ${size} ${up ? "above" : "below"} ${edge} ${cur} (close ${last} ${cur}, ${date}).`,
  },
  volume: {
    pl: (s: string, multiple: string, n: number, last: string, cur: string, date: string) =>
      `${s}: wolumen ${multiple} średniej z ${n} sesji (zamknięcie ${last} ${cur}, ${date}).`,
    en: (s: string, multiple: string, n: number, last: string, cur: string, date: string) =>
      `${s}: volume ${multiple} the ${n}-session average (close ${last} ${cur}, ${date}).`,
  },
  weight: {
    pl: (s: string, weight: string, above: boolean, threshold: string) =>
      `${s}: ${weight} portfela (${above ? "powyżej" : "poniżej"} ${threshold}).`,
    en: (s: string, weight: string, above: boolean, threshold: string) =>
      `${s}: ${weight} of the portfolio (${above ? "above" : "below"} ${threshold}).`,
  },
};
