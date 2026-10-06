// First steps in the app (design/v3/first-steps): a fresh profile with budget, loans and assets. Budget: the empty
// Wydatki tab is the Start page, a synthetic mBank CSV goes through the statement import drawer (Źródło -> Plik ->
// Podgląd -> Gotowe), the tab then shows data with the quiet strip, `ukryj` hides it across a reload. Loans: a loan
// through the drawer, then the installment phrase from the Start page. Assets: the Majątek widget on Przegląd is the
// first steps; a position, then a car with its depreciation curve. The CLI page links back to the in-app steps.
import type { Page } from "@playwright/test";
import { expect, go, serverUrl, test, toasts } from "../fixtures";

const NAME = "Demo Start";
const SLUG = "demo-start";

// Synthetic statement (no real data): the mBank export shape, ASCII only, one account number. No installment row:
// the built-in phrases would mark the loans step done before the drawer is used.
const MBANK = [
  "mBank S.A.",
  "Elektroniczne zestawienie operacji",
  "#Numer rachunku;",
  "12 3456 7890 1234 5678 9012 3456;",
  "#Waluta;",
  "PLN;",
  "",
  "#Data operacji;#Opis operacji;#Kwota;#Waluta;#Saldo po operacji;",
  "2026-09-02;PHU XQZW 7781;-49,99;PLN;4 950,01;",
  "2026-09-05;PENSJA WRZESIEN;6 000,00;PLN;10 950,01;",
  "2026-09-10;KAWIARNIA XYZ;-12,50;PLN;10 937,51;",
  "",
].join("\n");

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  const r = await request.post(`${serverUrl()}/api/profiles`, {
    headers: { "X-Finanse-Token": process.env.E2E_TOKEN ?? "" },
    data: { name: NAME, base_currency: "PLN", modules: ["budget", "loans", "assets"], mcp_privacy: "strict" },
  });
  expect(r.status(), await r.text()).toBe(201);
});

const strip = (page: Page, name: string) => page.locator(".notice", { hasText: new RegExp(`^${name} · `) });

test("budget: Start -> statement import drawer -> data with the quiet strip, ukryj survives a reload", async ({ app: page }) => {
  await go(page, `${SLUG}/budget.expenses`);
  const start = page.getByRole("region", { name: "Pierwsze kroki", exact: true });
  await expect(page.locator(".pagehead .ph")).toHaveText("Budżet domowy");
  await expect(page.getByRole("region", { name: "Agent AI", exact: true })).toBeVisible();
  await start.getByRole("button", { name: "Importuj wyciąg" }).click();

  const drawer = page.getByRole("dialog", { name: "Import wyciągu" });
  await expect(drawer.getByRole("radio", { name: /Plik CSV z banku/ })).toBeChecked();
  await expect(drawer.getByRole("radio", { name: /Konektor/ })).toBeDisabled();
  await drawer.getByRole("button", { name: "Dalej" }).click();

  await drawer.getByLabel("Plik z banku").setInputFiles({ name: "mbank-wrzesien.csv", mimeType: "text/csv", buffer: Buffer.from(MBANK, "latin1") });
  await drawer.getByRole("button", { name: "Podgląd" }).click();
  await expect(drawer).toContainText("mbank-wrzesien.csv");
  await expect(drawer).toContainText("(rozpoznany)");
  await expect(drawer.locator(".tag", { hasText: "3 nowe" })).toBeVisible();
  await expect(drawer.locator(".tag.info", { hasText: "nowe" })).toBeVisible(); // a new account
  await drawer.getByRole("button", { name: "Importuj 3 transakcje" }).click();
  await expect(drawer).toContainText("Zaimportowano 3 transakcje.");
  await expect(toasts(page)).toContainText("Zaimportowano 3 transakcje");

  // FE-2: the window regains focus (the file chooser closing, cmd-tab) with the drawer open on `Gotowe`: the DB is
  // `partial` now, yet nothing re-reads the profiles and swaps the Start page (and its drawer) away
  const profileReads: string[] = [];
  const onRequest = (r: { url(): string }) => { if (/\/api\/profiles$/.test(r.url())) profileReads.push(r.url()); };
  page.on("request", onRequest);
  const setupRead = page.waitForResponse((r) => r.url().endsWith(`/api/p/${SLUG}/modules/budget/setup`));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await setupRead; // the focus handlers ran (the setup poll's and the shell's fire on the same event)
  await page.waitForTimeout(500);
  page.off("request", onRequest);
  expect(profileReads).toEqual([]);
  await expect(drawer).toContainText("Zaimportowano 3 transakcje.");
  await expect(start).toBeVisible();

  await drawer.locator(".df").getByRole("button", { name: "Zamknij" }).click();
  await expect(drawer).toBeHidden();

  // partial: the tab shows its data with the one-line strip
  const s = strip(page, "Budżet domowy");
  await expect(s).toBeVisible({ timeout: 15_000 });
  await expect(s).toContainText(/\d z 3 kroków · następny: kategorie wydatków/);
  await expect(start).toHaveCount(0);
  await s.getByRole("button", { name: "ukryj" }).click();
  await expect(s).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Suma wydatków")).toBeVisible();
  await expect(strip(page, "Budżet domowy")).toHaveCount(0);

  // the tabbar Import opens the same drawer at the file step
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(drawer.getByLabel("Plik z banku")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("loans: add a loan, then recognise its installments", async ({ app: page }) => {
  await go(page, `${SLUG}/loans.list`);
  const start = page.getByRole("region", { name: "Pierwsze kroki", exact: true });
  await start.getByRole("button", { name: "Dodaj kredyt" }).click();
  const drawer = page.getByRole("dialog", { name: "Dodaj kredyt" });
  await drawer.getByLabel("Nazwa").fill("Hipoteka");
  await drawer.getByLabel("Kwota kredytu").fill("400000");
  await drawer.getByLabel("Oprocentowanie (% rocznie)").fill("6,5");
  await drawer.getByLabel("Okres").fill("25");
  await expect(drawer).toContainText(/rata ≈ 2\s700,83\szł · 300 rat/);
  await drawer.getByRole("button", { name: "Dodaj", exact: true }).click();
  await expect(toasts(page)).toContainText("Dodano kredyt Hipoteka");
  await expect(drawer).toBeHidden();

  // budget is on: the installment step remains -> the table with the strip
  const s = strip(page, "Kredyty");
  await expect(s).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Hipoteka" })).toBeVisible();
  await s.getByRole("button", { name: "Kontynuuj" }).click();
  await expect(page).toHaveURL(new RegExp(`#/${SLUG}/setup/loans$`));
  await start.getByRole("button", { name: "Wskaż ratę" }).click();
  const inst = page.getByRole("dialog", { name: "Rozpoznawanie rat" });
  await inst.getByLabel("Fraza").fill("RATA KREDYTU");
  await inst.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText(/Rozpoznano|brak pasujących przelewów/);
  await expect(inst).toBeHidden();
  await expect(start).toContainText("Hipoteka · fraza „RATA KREDYTU\"", { timeout: 15_000 });
});

test("assets: the Majątek widget is the first steps; a position, then a car with its curve", async ({ app: page }) => {
  await go(page, `${SLUG}/overview`);
  const widget = page.getByRole("region", { name: "Majątek", exact: true });
  await expect(widget.getByRole("button", { name: "Dodaj pozycję" })).toBeVisible();
  await expect(widget).toContainText("opcjonalnie");
  await widget.getByRole("button", { name: "Dodaj pozycję" }).click();
  const drawer = page.getByRole("dialog", { name: "Majątek" });
  await drawer.getByLabel("Nazwa").fill("Mieszkanie");
  await drawer.getByLabel("Wartość", { exact: true }).fill("500000");
  await drawer.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Dodano");
  await expect(widget.getByRole("button", { name: "Edytuj: Mieszkanie" })).toBeVisible({ timeout: 15_000 });

  await widget.getByRole("button", { name: "+ Dodaj" }).click();
  await drawer.getByLabel("Nazwa").fill("Auto");
  await drawer.getByLabel("Typ").selectOption({ label: "Auto" });
  await expect(drawer.getByLabel("Wartość", { exact: true })).toHaveCount(0);
  await drawer.getByLabel("Cena zakupu").fill("80000");
  await drawer.getByLabel("Data zakupu").fill("2025-05-01");
  await expect(drawer.getByLabel("Roczny spadek (%)")).toHaveValue("15");
  await expect(drawer).toContainText(/dziś ≈ .* · -.* \/ mies\./);
  await drawer.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Dodano");
  await expect(widget.getByRole("button", { name: "Edytuj: Auto" })).toBeVisible({ timeout: 15_000 });
  await expect(widget).toContainText("krzywa utraty wartości · 15 % / rok");
});

test("the CLI page links back to the in-app first steps", async ({ app: page }) => {
  await go(page, `${SLUG}/setup/budget/cli`);
  await expect(page.getByRole("heading", { name: "Budżet domowy · konfiguracja" })).toBeVisible();
  await expect(page.locator(".setup-steps").first()).toBeVisible();
  await page.getByRole("button", { name: "Pierwsze kroki w aplikacji" }).click();
  await expect(page).toHaveURL(new RegExp(`#/${SLUG}/setup/budget$`));
  await expect(page.getByRole("region", { name: "Pierwsze kroki", exact: true })).toBeVisible();
});
