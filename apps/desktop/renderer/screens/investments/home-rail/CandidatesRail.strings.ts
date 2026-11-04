import { catalog, plForm } from "@cashu/i18n";

export const C = catalog({
  candidates: { pl: "Kandydaci", en: "Candidates" },
  all: { pl: (n: number) => `wszyscy (${n})`, en: (n: number) => `all (${n})` },
  hidden: { pl: "Ukryte w trybie prywatnym.", en: "Hidden in privacy mode." },
  unavailable: {
    pl: "Kandydaci są teraz niedostępni.",
    en: "Candidates are currently unavailable.",
  },
  empty: { pl: "Brak nowych kandydatów.", en: "No new candidates." },
  fresh: {
    pl: (n: number) =>
      `${n === 1 ? "Jedna spółka" : `${n} ${plForm(n, "spółka", "spółki", "spółek")}`} spoza listy ${plForm(n, "pasuje", "pasują", "pasuje")} do Twoich kryteriów wejścia.`,
    en: (n: number) =>
      `${n === 1 ? "One company" : `${n} companies`} outside your list ${n === 1 ? "fits" : "fit"} your entry criteria.`,
  },
  why: { pl: "Dlaczego", en: "Why" },
  whyName: {
    pl: (name: string) => `Dlaczego ${name} pasuje`,
    en: (name: string) => `Why ${name} fits`,
  },
  watch: { pl: "Obserwuj", en: "Watch" },
  watchName: { pl: (name: string) => `Obserwuj ${name}`, en: (name: string) => `Watch ${name}` },
  watching: { pl: "Obserwujesz", en: "Watching" },
  watchingName: {
    pl: (name: string) => `Obserwujesz ${name}`,
    en: (name: string) => `Watching ${name}`,
  },
  dismiss: { pl: "Odrzuć", en: "Dismiss" },
  dismissName: { pl: (name: string) => `Odrzuć ${name}`, en: (name: string) => `Dismiss ${name}` },
});
