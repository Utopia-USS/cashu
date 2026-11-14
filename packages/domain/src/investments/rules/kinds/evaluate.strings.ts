/** Python rule messages, with the language supplied by the evaluation context. */
export const kindStrings = {
  noWeight: { pl: "Brak wagi", en: "No weight" },
  noUnrealized: { pl: "Brak wyniku niezrealizowanego", en: "No unrealized result" },
  compileFailed: {
    pl: "Nie udało się skompilować warunku reguły",
    en: "The rule condition could not be compiled",
  },
  conditionMet: { pl: "Warunek spełniony", en: "Condition met" },
  unknown: { pl: "nieznane", en: "unknown" },
  yes: { pl: "tak", en: "yes" },
  no: { pl: "nie", en: "no" },
  concentration: {
    pl: (label: string, weight: string, maximum: string) =>
      `${label}: ${weight} portfela (maks. ${maximum}).`,
    en: (label: string, weight: string, maximum: string) =>
      `${label}: ${weight} of the portfolio (max ${maximum}).`,
  },
  unrealized: {
    pl: (label: string, move: string, threshold: string) =>
      `${label}: ${move} od kosztu (próg ${threshold}).`,
    en: (label: string, move: string, threshold: string) =>
      `${label}: ${move} from cost (threshold ${threshold}).`,
  },
  drawdown: {
    pl: (
      label: string,
      drop: string,
      count: number,
      last: string,
      lastDate: string,
      high: string,
      highDate: string,
      threshold: string,
    ) =>
      `${label}: -${drop} od szczytu z ${count} sesji (zamknięcie ${last} ${lastDate}, szczyt ${high} ${highDate}; próg -${threshold}).`,
    en: (
      label: string,
      drop: string,
      count: number,
      last: string,
      lastDate: string,
      high: string,
      highDate: string,
      threshold: string,
    ) =>
      `${label}: -${drop} from the ${count}-session high (close ${last} ${lastDate}, high ${high} ${highDate}; threshold -${threshold}).`,
  },
  drift: {
    pl: (
      bucket: string,
      over: boolean,
      drift: string,
      weight: string,
      target: string,
      amount: string,
    ) =>
      `${bucket} ${over ? "powyżej" : "poniżej"} celu o ${drift} (${weight} wobec ${target}, ${over ? `${amount} ponad cel` : `do celu brakuje ${amount}`}).`,
    en: (
      bucket: string,
      over: boolean,
      drift: string,
      weight: string,
      target: string,
      amount: string,
    ) =>
      `${bucket} ${over ? "above" : "below"} the target by ${drift} (${weight} vs ${target}, ${over ? `${amount} over the target` : `${amount} short of the target`}).`,
  },
  cash: {
    pl: (weight: string, below: boolean, threshold: string) =>
      `Gotówka: ${weight} portfela, ${below ? "poniżej minimum" : "powyżej maksimum"} ${threshold}.`,
    en: (weight: string, below: boolean, threshold: string) =>
      `Cash: ${weight} of the portfolio, ${below ? "below the minimum" : "above the maximum"} ${threshold}.`,
  },
  noDeposits: {
    pl: (amount: string, currency: string) =>
      `Brak wpłat, choć plan zakłada ${amount} ${currency} miesięcznie.`,
    en: (amount: string, currency: string) =>
      `No contributions, though the plan expects ${amount} ${currency} a month.`,
  },
  contributionGap: {
    pl: (days: string, last: string, allowed: string) =>
      `Brak wpłaty od ${days} (ostatnia ${last}); plan dopuszcza ${allowed}.`,
    en: (days: string, last: string, allowed: string) =>
      `No contribution for ${days} (last ${last}); the plan allows ${allowed}.`,
  },
  tagged: {
    pl: (tags: string, weight: string, maximum: string, labels: string) =>
      `Pozycje z tagami ${tags}: ${weight} portfela (maks. ${maximum}): ${labels}.`,
    en: (tags: string, weight: string, maximum: string, labels: string) =>
      `Positions tagged ${tags}: ${weight} of the portfolio (max ${maximum}): ${labels}.`,
  },
} as const;
