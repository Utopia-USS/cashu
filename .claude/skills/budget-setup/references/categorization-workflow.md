# Categorization backend and first categorization pass

What this is: steps 7-8 of `/budget-setup` - choosing the LLM backend for unknown merchants and the
first categorization pass through the profile's cashU MCP server, with the category key list.

## Step 7 - Categorization backend (Decision)

The ~420 Polish rules always run after import. For the tail of unknown merchants, an LLM is optional:

- **Ollama (default, offline):** nothing leaves the machine. `ollama serve`, `ollama pull qwen2.5:3b`
  (or `:7b` for better coverage).
- **Anthropic (cloud):** `CASHU_CATEGORIZE_LLM_BACKEND=anthropic` in `.env`, and the user stores the
  key with `cashu secrets set anthropic` in their own terminal (hidden prompt). Sends only the
  merchant-name string. Confirm explicitly that the user accepts sending merchant names to the cloud
  before enabling it.

Then you may run `cashu --profile <slug> categorize` or `categorize --llm` (prints counts only).

## Step 8 - First categorization pass (MCP)

1. `uncategorized_merchants(20)`: merchant names with transaction counts, most frequent first.
2. Propose a category for each from the list below, in batches of 5-8, as a table "merchant ->
   proposed category"; let the user accept, change or skip each (question tool with options works
   well). A merchant the user does not recognize is skipped, never guessed.
   `payee:<hash>` entries are private persons: do not guess who it is and do not ask for the name.
   Skip them, or let the user categorize them in the Wydatki tab where they see the real payee;
   `set_merchant_category` accepts the reference only if the user tells you the category for it.
3. For each confirmed one: `set_merchant_category(merchant, category)`. It creates a learned rule for
   this profile that wins over the built-in rules (same as `cashu set-category` or changing the
   category in the Wydatki tab).
4. Repeat until the user stops or the list is short. Re-check `setup_status("budget")`.

## Category keys

Category keys (label shown in the app): `groceries` Spożywcze, `dining` Gastronomia, `transport`
Transport, `fuel` Paliwo, `car` Auto, `housing` Mieszkanie/Czynsz, `loans` Raty kredytów, `utilities`
Media/Telekom, `health` Zdrowie/Apteka, `shopping` Zakupy, `entertainment` Rozrywka, `subscriptions`
Subskrypcje, `travel` Podróże, `education` Edukacja, `personal_care` Higiena/Uroda, `gifts`
Prezenty/Darowizny, `private` Prywatne (owner only: transfers to and from other people, both
directions; never guess it), `cash` Gotówka, `fees` Opłaty bankowe, `taxes` Podatki, `other` Inne,
`income_salary` Pensja, `income_refund` Zwroty, `income_other` Inne przychody, `transfer` Przelew
własny, `cash_withdrawal` Wypłata gotówki. The source of truth is the app's category list:
`uncategorized_merchants` lists the valid keys and `set_merchant_category` rejects unknown ones.

Loan and mortgage installments belong to `loans` (the loans module recognises them; see
`/loans-setup`), never to `subscriptions`.
