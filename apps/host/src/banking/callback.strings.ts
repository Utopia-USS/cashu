/** Local browser callback page, selected by the host's current UI language. */
export const S = {
  accepted: {
    pl: "Otrzymano autoryzację banku. Wróć do cashU.",
    en: "Bank authorization received. Return to cashU.",
  },
  denied: {
    pl: "Bank albo Enable Banking nie udzielił zgody. Wróć do cashU, tam zobaczysz, co dalej.",
    en: "The bank or Enable Banking did not grant the consent. Return to cashU to see what to do next.",
  },
  stale: {
    pl: "Ten adres powrotu jest już nieaktualny. Wróć do cashU i połącz bank jeszcze raz.",
    en: "This return address is no longer current. Return to cashU and connect the bank again.",
  },
} as const;
