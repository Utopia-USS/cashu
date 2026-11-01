/**
 * The three system prompts and the user-message prefixes of the LLM categorization, verbatim from
 * `categorize/local_llm.py` (Ollama) and `categorize/llm.py` (Anthropic). Prompt text is data: a
 * one-byte change changes what the model answers (R3), so the matching data pins every prompt by
 * value. U+2014 is built from its code point (the sources keep no literal em dash).
 */

const EM_DASH = String.fromCodePoint(0x2014);

/** `local_llm._system_prompt`: the Ollama merchant prompt. */
export function ollamaMerchantSystemPrompt(categoryKeys: readonly string[]): string {
  return (
    "You categorize Polish bank-transaction merchant strings into exactly one " +
    "category key from this list:\n" +
    categoryKeys.join(", ") +
    "\n" +
    'Rules: pick the single best key; if unsure use "other". ' +
    "Examples: ZABKA->groceries, ORLEN->fuel, NETFLIX.COM->subscriptions, " +
    "UBER EATS->dining, UBER *TRIP->transport, TAURON->utilities, " +
    "APTEKA->health, ALLEGRO->shopping, PAYU/PRZELEWY24->other. " +
    'Return JSON {"results":[{"id","category","confidence"}]} for every input id.'
  );
}

/** `local_llm._txn_system_prompt`: the Ollama full-transaction prompt (Polish), `key = label` lines. */
export function ollamaTxnSystemPrompt(labels: ReadonlyMap<string, string>): string {
  const cats = [...labels].map(([k, v]) => `${k} = ${v}`).join("\n");
  return (
    "Kategoryzujesz polskie transakcje bankowe. Dla KAŻDEJ transakcji wybierz " +
    "dokładnie jeden klucz kategorii z listy:\n" +
    cats +
    "\n\n" +
    "Zasady:\n" +
    "- Używaj WSZYSTKICH danych: odbiorcy/nadawcy, tytułu, opisu, kwoty i kierunku.\n" +
    "- Kwota dodatnia = WPŁYW => kategoria income_* (income_salary dla pensji, " +
    "income_refund dla zwrotów, inaczej income_other).\n" +
    "- BRAMKI PŁATNICZE i BLIK (PayU, PayPro, Przelewy24/P24, DotPay, Blue Media, " +
    "Autopay, PayPal, SumUp, eCard/ECARD, Tpay, Cinkciarz): nazwa operatora to NIE " +
    "jest kategoria. Znajdź prawdziwego sprzedawcę w tytule/opisie " +
    "(np. 'PayU*Allegro' => shopping, 'BLIK ... ALLEGRO' => shopping, " +
    "'PayPal *STEAM' => entertainment, 'PRZELEWY24 GLOVO' => dining). Jeśli " +
    "prawdziwego sprzedawcy NIE MA w danych: zakup e-commerce/kartą nieznany => " +
    "shopping; przelew/BLIK do osoby prywatnej => other; naprawdę nieznane => other.\n" +
    `- Ten sam sprzedawca MOŻE mieć różne kategorie ${EM_DASH} oceniaj każdą transakcję po ` +
    "jej treści, nie po samej nazwie.\n" +
    "- Przykłady: ZABKA/LIDL/BIEDRONKA => groceries, ORLEN/BP/STACJA PALIW => fuel, " +
    "NETFLIX/SPOTIFY => subscriptions, UBER EATS/GLOVO/PYSZNE => dining, " +
    "UBER/BOLT/MPK => transport, APTEKA/PRZYCHODNIA => health, ALLEGRO/AMAZON => " +
    "shopping, TAURON/ORANGE/PLAY => utilities, BOOKING/AIRBNB => travel, " +
    "ZUS/URZAD SKARBOWY => taxes.\n" +
    "- Jeśli niepewne => other (dla wpływów income_other).\n" +
    'Zwróć JSON {"results":[{"id","category","confidence"}]} dla każdego id.'
  );
}

/** The Anthropic sentinels (`llm._OTHER`, `llm._UNKNOWN`). */
export const OTHER = "other";
export const UNKNOWN = "UNKNOWN";

/** `llm._build_system_blocks` text: the Anthropic merchant prompt (byte-stable for prompt caching). */
export function anthropicSystemText(categoryKeys: readonly string[]): string {
  return (
    "You are a precise merchant-name classifier for a personal-finance " +
    "tracker. Given short, noisy merchant strings (often uppercased, " +
    "abbreviated, or containing payment-processor noise, mostly Polish), " +
    "assign each to exactly ONE category.\n" +
    "\n" +
    `Allowed categories: ${categoryKeys.join(", ")}.\n` +
    `If none clearly fits, use "${OTHER}". If the string carries no usable ` +
    `signal at all, use "${UNKNOWN}".\n` +
    "\n" +
    `Payment aggregators / processors are NOT a merchant category ${EM_DASH} a raw ` +
    'aggregator string with no underlying merchant must be "other". ' +
    "Examples:\n" +
    '- "ZABKA" -> groceries\n' +
    '- "BIEDRONKA" -> groceries\n' +
    '- "ORLEN" -> fuel\n' +
    '- "NETFLIX.COM" -> subscriptions\n' +
    '- "UBER EATS" -> dining\n' +
    '- "PAYU" -> other\n' +
    '- "PRZELEWY24" -> other\n' +
    "\n" +
    "For every input item, output an object with its id, the chosen " +
    "category (exactly one of the allowed values), and a confidence in " +
    "[0,1]. Base the decision only on the merchant string itself."
  );
}

/** User-message prefixes (Ollama merchants, Ollama transactions, Anthropic merchants). */
export const OLLAMA_MERCHANT_PREFIX = "Classify:\n";
export const OLLAMA_TXN_PREFIX = "Sklasyfikuj transakcje:\n\n";
export const ANTHROPIC_MERCHANT_PREFIX =
  "Classify each of the following merchant strings. Return one result " +
  "per item, keyed by the given id:\n";
