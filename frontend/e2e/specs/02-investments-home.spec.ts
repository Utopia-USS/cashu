// Investments home renders from the demo data; a daily check run elsewhere is pushed to the open page and the value
// chart follows the hero (F7 FE7: the chart's last point equals the hero value after a run that adds a new bar; P10).
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { ANNA, expect, go, plNumber, serverUrl, test } from "../fixtures";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The demo data ends at the last session before the seeding day, so a run on a weekend (or right after seeding) has no
// new session to fetch. Drop the newest bar of Anna's instruments once: the run then fetches it again (the synthetic
// source is deterministic) and the hero moves on any day.
const DROP_LAST_SESSION = `
import os, sqlite3
db = sqlite3.connect(os.path.join(os.environ["E2E_DATA_DIR"], "cashu.db"))
ids = [r[0] for r in db.execute(
    "select distinct t.instrument_id from inv_transactions t join accounts a on a.id = t.account_id "
    "join profiles p on p.id = a.profile_id where p.slug = 'demo-anna' and t.instrument_id is not null")]
for i in ids:
    db.execute("delete from inv_price_bars where instrument_id = ? and date = "
               "(select max(date) from inv_price_bars where instrument_id = ?)", (i, i))
db.commit()
`;
test.beforeAll(() => {
  const r = spawnSync(join(REPO, ".venv", "bin", "python"), ["-c", DROP_LAST_SESSION], { env: process.env, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`dropping the last session failed:\n${r.stdout}\n${r.stderr}`);
});

const heroValue = async (page: Page) =>
  plNumber(await page.getByRole("region", { name: "Wartość portfela" }).locator(".h1 .v").innerText());
const chartValue = async (page: Page) =>
  plNumber((await page.locator("#inv-value").getByText(/^portfel\s+\d/).textContent()) ?? "");

test("investments home renders hero, signals, alerts, research, chart", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const hero = page.getByRole("region", { name: "Wartość portfela" });
  await expect(hero).toContainText("zł");
  expect(await heroValue(page)).toBeGreaterThan(10_000);
  await expect(page.getByRole("region", { name: "Sygnały" }).locator(".hlead")).not.toBeEmpty();
  await expect(page.getByText("Demo Global Equity UCITS ETF").first()).toBeVisible();
  // Alerty lists only what is close or fired; every live alert is behind "Wszystkie (n)".
  await expect(page.getByRole("region", { name: "Alerty" }).getByRole("button", { name: /^Wszystkie \(\d+\)$/ })).toBeVisible();
  // home v3 (Q6): the watchlist is the Obserwowane tab of Aktywa.
  const assets = page.getByRole("region", { name: "Aktywa" });
  await assets.getByRole("button", { name: /^Obserwowane \d+$/ }).click();
  await expect(assets.getByText("Demo Wodociągi SA")).toBeVisible();
  // The benchmark by its name, never the strategy id (F7 GF7).
  await expect(page.locator("#inv-value")).toContainText("MSCI ACWI");
  await expect(page.locator("#inv-value")).not.toContainText("msci_acwi");
  await expect(page.locator("#inv-value").getByText(/^portfel\s+\d/)).toBeVisible();
});

test("a daily check run elsewhere is pushed to the open page: the value chart follows the hero", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  await expect(page.locator("#inv-value").getByText(/^portfel\s+\d/)).toBeVisible();
  // P10: no button, the app runs the daily check on its own (off in this offline server)
  await expect(page.getByRole("button", { name: "↻ Synchronizuj" })).toHaveCount(0);
  const before = await heroValue(page);
  expect(Math.abs(Math.round(before) - (await chartValue(page)))).toBeLessThanOrEqual(1);

  // Another process runs the check (the worker, the CLI, an agent): the page learns it from the change stream.
  const r = await page.request.post(`${serverUrl()}/api/p/${ANNA}/investments/run`, {
    headers: { "X-Cashu-Token": process.env.E2E_TOKEN ?? "" }, data: {},
  });
  expect(r.ok()).toBeTruthy();
  // The run fetched one more session (synthetic source): the hero moves without a reload, the chart must follow.
  await expect.poll(() => heroValue(page), { timeout: 15_000 }).not.toBe(before);
  const after = await heroValue(page);
  await expect.poll(async () => Math.abs(Math.round(after) - (await chartValue(page))), { timeout: 15_000 }).toBeLessThanOrEqual(1);
});
