// Connectors (design/v3/connectors): the example budget file connector is installed with the CLI (never approved
// by it), approved in Ustawienia > Konektory after a look at its code, then imports a synthetic statement through the
// budget statement drawer under the real macOS sandbox. A file edit flips it to `zmieniony` with a line diff;
// approving again restores it; deleting removes it.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, go, openSettings, serverUrl, test, toasts } from "../fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EXAMPLE = join(REPO, "examples", "connectors", "budget-csv-example");
const ID = "budget-csv-example";
const NAME = "Przykładowy Bank CSV (przykład)";
const PROFILE = "Demo Konektor";
const SLUG = "demo-konektor";

test.describe.configure({ mode: "serial" });

const PYTHON = join(REPO, ".venv", "bin", "python");
/** The server's Python env (global-setup): the memory keyring, never the developer's login keychain (FE-13). */
function pyEnv(): NodeJS.ProcessEnv {
  const backend = process.env.E2E_PYTHON_KEYRING_BACKEND;
  if (!backend) throw new Error("E2E_PYTHON_KEYRING_BACKEND is not set (global setup did not run)");
  return { ...process.env, FINANSE_DATA_DIR: process.env.E2E_DATA_DIR, PYTHON_KEYRING_BACKEND: backend, PYTHONPATH: process.env.E2E_PYTHONPATH };
}

function cli(...args: string[]) {
  const r = spawnSync(PYTHON, ["-c", "from finanse.cli import app; app()", ...args], { env: pyEnv(), encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`finanse ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** Transactions stored for a profile (read straight from the e2e database: the approval must write rows). */
function txnCount(slug: string): number {
  const code = "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); print(c.execute("
    + "'select count(*) from transactions t join accounts a on a.id = t.account_id join profiles p on p.id = a.profile_id where p.slug = ?', "
    + "(sys.argv[2],)).fetchone()[0])";
  const r = spawnSync(PYTHON, ["-c", code, join(process.env.E2E_DATA_DIR!, "finanse.db"), slug], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`txn count failed:\n${r.stderr}`);
  return Number(r.stdout.trim());
}

const hashOf = async (d: Locator) => (await d.locator("code", { hasText: /^sha256 / }).first().innerText()).trim();

test.beforeAll(async ({ request }) => {
  const sys = await request.get(`${serverUrl()}/api/system`, { headers: { "X-Finanse-Token": process.env.E2E_TOKEN ?? "" } });
  const sandbox = ((await sys.json()) as { connectors?: { sandbox?: boolean } }).connectors?.sandbox;
  test.skip(sandbox === false, "connectors run only under the macOS sandbox");
  cli("connectors", "add", EXAMPLE);
  const r = await request.post(`${serverUrl()}/api/profiles`, {
    headers: { "X-Finanse-Token": process.env.E2E_TOKEN ?? "" },
    data: { name: PROFILE, base_currency: "PLN", modules: ["budget"], mcp_privacy: "strict" },
  });
  expect(r.status(), await r.text()).toBe(201);
});

const card = (page: Page) => page.getByRole("region", { name: "Konektory", exact: true });
const row = (page: Page) => card(page).locator(`[data-connector="${ID}"]`);
const drawer = (page: Page) => page.getByRole("dialog", { name: "Konektor" });

async function openConnectors(page: Page) {
  await go(page, `${SLUG}/settings/connectors`);
  await expect(card(page)).toBeVisible();
}

test("Ustawienia > Konektory: review the code and approve", async ({ app: page }) => {
  await go(page, `${SLUG}/budget.expenses`);
  await openSettings(page);
  await expect(page.getByRole("navigation", { name: "Sekcje ustawień" }).getByRole("button", { name: "Konektory", exact: true })).toBeVisible();
  await expect(row(page)).toContainText(NAME);
  await expect(row(page).locator(".tag", { hasText: "do zatwierdzenia" })).toBeVisible();
  await expect(card(page).locator(".tag", { hasText: "1 do zatwierdzenia" })).toBeVisible();
  await row(page).getByRole("button", { name: "Przejrzyj i zatwierdź" }).click();

  const d = drawer(page);
  await expect(d.getByText("Co zatwierdzasz")).toBeVisible();
  await expect(d).toContainText("python3 connector.py");
  await expect(d).toContainText(/sha256 [0-9a-f]{12}…/);
  await expect(d).toContainText("piaskownica bez dostępu do sieci");
  await d.getByRole("button", { name: "connector.py", exact: true }).click();
  const viewer = d.getByRole("region", { name: "connector.py" });
  await expect(viewer).toContainText("def convert(");
  await expect(viewer).toContainText(/\d+ linii/);
  await viewer.getByRole("button", { name: "zamknij" }).click();
  await expect(viewer).toBeHidden();

  // FE-12: the file changes while the drawer is open: approve refuses (409), the drawer reloads the new hash
  const seen = await hashOf(d);
  appendFileSync(join(process.env.E2E_DATA_DIR!, "connectors", ID, "connector.py"), "# e2e edit while open\n");
  await d.getByRole("button", { name: "Zatwierdź", exact: true }).click();
  await expect(d.locator(".notice.neg")).toContainText("Konektor zmienił się, odkąd go otworzyłeś");
  await expect.poll(() => hashOf(d)).not.toBe(seen);
  await expect(d.locator(".dh .tag", { hasText: "do zatwierdzenia" })).toBeVisible();

  await d.getByRole("button", { name: "Zatwierdź", exact: true }).click();
  await expect(toasts(page)).toContainText(`Zatwierdzono ${NAME}`);
  await expect(d.locator(".dh .tag", { hasText: "zatwierdzony" })).toBeVisible();
  await expect(d.getByRole("button", { name: "Wyłącz" })).toBeVisible();
  await d.getByRole("button", { name: "Zamknij" }).click();
  await expect(row(page).locator(".tag", { hasText: "zatwierdzony" })).toBeVisible();
});

test("budget statement drawer: a bad file shows the connector failure, the sample imports", async ({ app: page }) => {
  await go(page, `${SLUG}/budget.expenses`);
  await page.getByRole("region", { name: "Pierwsze kroki", exact: true }).getByRole("button", { name: "Importuj wyciąg" }).click();
  const d = page.getByRole("dialog", { name: "Import wyciągu" });
  const radio = d.getByRole("radio", { name: new RegExp(NAME.replace(/[()]/g, "\\$&")) });
  await expect(radio).toBeEnabled();
  await radio.check();
  await d.getByRole("button", { name: "Dalej" }).click();

  // FE-7: a file picked for the connector is not kept for another source
  await d.getByLabel("Plik z banku").setInputFiles({ name: "przykladowy.csv", mimeType: "text/csv", buffer: readFileSync(join(EXAMPLE, "sample.csv")) });
  await expect(d.getByRole("button", { name: "Podgląd" })).toBeEnabled();
  await d.getByRole("button", { name: "← Wstecz" }).click();
  await d.getByRole("radio", { name: /Plik CSV z banku/ }).check();
  await d.getByRole("button", { name: "Dalej" }).click();
  await expect(d.getByRole("button", { name: "Podgląd" })).toBeDisabled();
  await d.getByRole("button", { name: "← Wstecz" }).click();
  await radio.check();
  await d.getByRole("button", { name: "Dalej" }).click();
  await expect(d.locator(".field", { hasText: "Konektor" })).toContainText(NAME);
  await expect(d.getByLabel("Bank", { exact: true })).toHaveCount(0);

  await d.getByLabel("Plik z banku").setInputFiles({ name: "zly.csv", mimeType: "text/csv", buffer: Buffer.from("to nie jest wyciag\n1;2;3\n") });
  await d.getByRole("button", { name: "Podgląd" }).click();
  await expect(d.locator(".notice.neg")).toContainText("Konektor nie rozpoznał tego pliku.");

  await d.getByLabel("Plik z banku").setInputFiles({ name: "przykladowy.csv", mimeType: "text/csv", buffer: readFileSync(join(EXAMPLE, "sample.csv")) });
  await d.getByRole("button", { name: "Podgląd" }).click();
  await expect(d).toContainText("przykladowy.csv");
  await expect(d.locator(".tag", { hasText: "4 nowe" })).toBeVisible();
  await d.getByRole("button", { name: "Importuj 4 transakcje" }).click();
  await expect(d).toContainText("Zaimportowano 4 transakcje.");
});

test("a changed file: zmieniony with a line diff, approve again, then delete", async ({ app: page }) => {
  // the installed copy (0700, the app's) is edited behind the app's back
  appendFileSync(join(process.env.E2E_DATA_DIR!, "connectors", ID, "connector.py"), "# e2e change\n");
  await openConnectors(page);
  await card(page).getByRole("button", { name: "Odśwież" }).click();
  await expect(row(page).locator(".tag", { hasText: "zmieniony" })).toBeVisible();
  await row(page).getByRole("button", { name: "Sprawdź zmiany" }).click();

  const d = drawer(page);
  await expect(d.locator(".notice.warn")).toContainText("Pliki zmieniły się od zatwierdzenia (1 zmieniony)");
  await d.getByRole("button", { name: "connector.py", exact: true }).click();
  const viewer = d.getByRole("region", { name: "connector.py" });
  await expect(viewer.locator("span.d.add")).toContainText("# e2e change");
  await expect(viewer).toContainText("+1");
  await viewer.getByRole("button", { name: "cały plik" }).click();
  await expect(viewer).toContainText("def convert(");

  await d.getByRole("button", { name: "Zatwierdź ponownie" }).click();
  await expect(toasts(page)).toContainText(`Zatwierdzono ${NAME}`);
  await expect(d.locator(".dh .tag", { hasText: "zatwierdzony" })).toBeVisible();

  // FE-5: a disabled connector edited on disk: the same notice and line diff before `Zatwierdź i włącz`
  await d.getByRole("button", { name: "Wyłącz" }).click();
  await expect(d.locator(".dh .tag", { hasText: "wyłączony" })).toBeVisible();
  await d.getByRole("button", { name: "Zamknij", exact: true }).click();
  appendFileSync(join(process.env.E2E_DATA_DIR!, "connectors", ID, "connector.py"), "# e2e change while disabled\n");
  await card(page).getByRole("button", { name: "Odśwież" }).click();
  await expect(row(page).locator(".tag", { hasText: "zmieniony" })).toBeVisible();
  await row(page).getByRole("button", { name: "Sprawdź zmiany" }).click();
  await expect(d.locator(".notice.warn")).toContainText("Pliki zmieniły się od zatwierdzenia (1 zmieniony). Przejrzyj zmiany przed włączeniem.");
  await d.getByRole("button", { name: "connector.py", exact: true }).click();
  await expect(d.getByRole("region", { name: "connector.py" }).locator("span.d.add")).toContainText("# e2e change while disabled");
  await d.getByRole("button", { name: "Zatwierdź i włącz" }).click();
  await expect(toasts(page)).toContainText(`Zatwierdzono ${NAME}`);
  await expect(d.locator(".dh .tag", { hasText: "zatwierdzony" })).toBeVisible();
  // the run history shows the two connector runs of the import step (the failed one with its kind)
  await expect(d.locator("table", { hasText: "Polecenie" }).last()).toContainText("odrzucony plik");

  await d.getByRole("button", { name: "Usuń", exact: true }).click();
  await expect(d).toContainText(`Usunąć ${NAME}?`);
  await d.getByRole("button", { name: "Tak, usuń" }).click();
  await expect(toasts(page)).toContainText(`Usunięto ${NAME}`);
  await expect(row(page)).toHaveCount(0);
  await expect(card(page)).toContainText("Brak konektorów");
});

// A synthetic budget fetch connector (e2e/fixtures/budget-fetch-e2e: no network, fixed made-up data) bound to the
// account the file import created: the form stores the key in the keychain, `check` connects, the first sync is a
// proposal the owner approves from the toast.
const FETCH_ID = "budget-fetch-e2e";
const FETCH_NAME = "E2E Bank API";

test("fetch connector: bind an account, check, sync to a proposal, approve it", async ({ app: page }) => {
  cli("connectors", "add", join(HERE, "..", "fixtures", FETCH_ID));
  await openConnectors(page);
  await card(page).getByRole("button", { name: "Odśwież" }).click();
  const r = card(page).locator(`[data-connector="${FETCH_ID}"]`);
  await expect(r).toContainText(FETCH_NAME);
  await r.getByRole("button", { name: "Przejrzyj i zatwierdź" }).click();

  const d = drawer(page);
  await expect(d).toContainText("api.example.com");
  await expect(d).toContainText("Klucz API");
  await expect(d.getByRole("button", { name: "+ Powiąż konto" })).toBeDisabled();
  await d.getByRole("button", { name: "Zatwierdź", exact: true }).click();
  await expect(toasts(page)).toContainText(`Zatwierdzono ${FETCH_NAME}`);

  await d.getByRole("button", { name: "+ Powiąż konto" }).click();
  await expect(d.getByLabel("Konto", { exact: true })).toBeVisible();
  await d.getByLabel("Klucz API", { exact: true }).fill("e2e-not-a-real-key");
  await d.getByRole("button", { name: "Zapisz i sprawdź" }).click();
  await expect(d.locator(".notice.pos")).toContainText("Połączono");
  await d.getByRole("button", { name: "Gotowe" }).click();

  const binding = d.locator(".row", { hasText: "sekrety: ustawione" });
  await expect(binding.locator(".tag", { hasText: "po pierwszym imporcie" })).toBeVisible();
  await binding.getByRole("button", { name: "Synchronizuj" }).click();
  const toast = toasts(page).locator("div", { hasText: "Import czeka na zatwierdzenie · 2 nowe rekordy" }).last();
  await expect(toast).toBeVisible();
  // BE-2: while that proposal waits, another sync runs nothing and points at it
  await binding.getByRole("button", { name: "Synchronizuj" }).click();
  await expect(toasts(page)).toContainText("Poprzedni import czeka na zatwierdzenie · 2 nowe rekordy");
  await d.getByRole("button", { name: "Zamknij", exact: true }).click();

  // FE-12: the budget tabbar's `Do zatwierdzenia · 1` opens it (design D6); the approval writes the rows
  const before = txnCount(SLUG);
  await go(page, `${SLUG}/budget.expenses`);
  await page.getByRole("button", { name: "Do zatwierdzenia · 1" }).click();
  const proposal = page.getByRole("dialog", { name: "Propozycja agenta" });
  await expect(proposal).toContainText("import wyciągu");
  await expect(proposal).toContainText(FETCH_NAME);
  await expect(proposal.locator(".tag", { hasText: "konektor" })).toBeVisible();
  await proposal.getByRole("button", { name: "Zatwierdź import" }).click();
  await expect(toasts(page)).toContainText("Zaimportowano");
  await expect(proposal).toBeHidden();
  await expect(page.getByRole("button", { name: /^Do zatwierdzenia/ })).toHaveCount(0);
  expect(txnCount(SLUG)).toBe(before + 2);

  // FE-3: the tabbar sync reports the connector line (synced minutes ago: skipped until the 20 h interval passes)
  await page.getByRole("button", { name: "↻ Synchronizuj" }).click();
  await expect(toasts(page)).toContainText(`${FETCH_NAME}: pominięty · pobrany w ciągu 20 h`);
});
