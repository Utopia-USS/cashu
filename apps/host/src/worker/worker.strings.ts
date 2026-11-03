import { enCount, plCount } from "@cashu/i18n";
export const S = {
  title: { pl: (name: string) => `cashU: ${name}`, en: (name: string) => `cashU: ${name}` },
  action: { pl: "Sygnał do działania", en: "Action signal" },
  info: { pl: "Sygnał informacyjny", en: "Info signal" },
  signal: { pl: "Sygnał", en: "Signal" },
  newSignals: { pl: "Nowe sygnały", en: "New signals" },
  more: {
    pl: (n: number) => `Jeszcze ${plCount(n, "sygnał", "sygnały", "sygnałów")}`,
    en: (n: number) => `${enCount(n, "signal", "signals")} more`,
  },
  weekly: { pl: "Przegląd tygodniowy", en: "Weekly review" },
  digest: {
    pl: (n: number) =>
      n === 0
        ? "Brak sygnałów do przeglądu"
        : `${plCount(n, "sygnał", "sygnały", "sygnałów")} do przeglądu`,
    en: (n: number) =>
      n === 0 ? "No signals to review" : `${enCount(n, "signal", "signals")} to review`,
  },
} as const;
