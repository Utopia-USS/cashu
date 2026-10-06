// P2 strategy hints and P3 recommendation freshness. The demo data gives Anna's GLBA a recommendation that may be
// outdated (a note, a thesis and an alert after it); e2e/seed_hints.py adds the rest through the service layer:
// Piotr's GLBA recommendation outdated by an invalidating note, Piotr's DMTC thesis fulfilled by a note stored before
// a thesis edit (`predates_thesis`), and a triggered alert on Anna's watched DMSE.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANNA, expect, go, PIOTR, test } from "../fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

test.beforeAll(() => {
  const dataDir = process.env.E2E_DATA_DIR;
  if (!dataDir) throw new Error("E2E_DATA_DIR is not set (global setup did not run)");
  const r = spawnSync(join(REPO, ".venv", "bin", "python"), [join(HERE, "..", "seed_hints.py")], {
    env: { ...process.env, FINANSE_DATA_DIR: dataDir }, encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`seed_hints.py failed:\n${r.stdout}\n${r.stderr}`);
});

test("held: a fulfilled thesis shows its chip, the card's strategia row and the faded ring; the note is tagged", async ({ app: page }) => {
  await go(page, `${PIOTR}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  await expect(assets.getByRole("columnheader", { name: "Strategia" })).toBeVisible();
  const row = assets.locator("tr.rowlink", { hasText: "DMTC" }).first();
  await expect(row.locator(".c-hint .hint.review")).toHaveText("teza spełniona");
  await expect(row.locator(".c-hint .hint")).toHaveAttribute("title", "teza spełniona: sprawdź plan wyjścia");
  await expect(row.locator(".av[data-health='ful'][data-pre]")).toHaveCount(1);
  await row.locator("button.nm").hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("strategia");
  await expect(card.locator(".hv.review")).toHaveText("teza spełniona: sprawdź plan wyjścia");
  await expect(card).toContainText("spełniona · research sprzed zmiany tezy");
  await page.mouse.move(0, 0);
  await row.click();
  const drawer = page.locator(".adrawer");
  await expect(drawer.locator(".ahead .hsub .hint")).toHaveText("teza spełniona");
  await expect(drawer.locator(".nr", { hasText: "osiągnął cel" }).locator(".tag.pre")).toHaveText("sprzed zmiany tezy");
  await expect(drawer.locator(".health.pre")).toHaveCount(1);
});

test("outdated recommendation: red coin rim, rule chip, red Rekomendacja card with its reasons", async ({ app: page }) => {
  await go(page, `${PIOTR}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  const row = assets.locator("tr.rowlink", { hasText: "GLBA" }).first();
  await expect(row.locator(".avw[data-plan='hold'][data-fresh='out']")).toHaveCount(1);
  await expect(row.locator(".c-hint .hint.rule")).toHaveText("rekomendacja nieaktualna");
  await row.click();
  const drawer = page.locator(".adrawer");
  const rec = drawer.locator(".w.recw.out");
  await expect(rec).toBeVisible();
  await expect(rec.locator(".tag.neg")).toHaveText("nieaktualna");
  await expect(rec.locator(".rsn")).toContainText("notatka podważa tezę");
  const header = drawer.locator(".ahead .hsub .hint.rule");
  await expect(header).toHaveText("rekomendacja nieaktualna");
  await expect(header).toHaveAttribute("title", /zaszedł warunek unieważnienia tezy/);
  // every hint reachable by keyboard / screen reader (the chip is focusable and described by all lines)
  await expect(header).toHaveAttribute("tabindex", "0");
  const described = await header.getAttribute("aria-describedby");
  await expect(page.locator(`[id="${described}"]`)).toContainText("zaszedł warunek unieważnienia tezy");
  // the reason links to its note in the research slot
  await rec.locator(".rsn").getByRole("button", { name: /notatka podważa tezę/ }).click();
  await expect(page).toHaveURL(/\?note=\d+/);
});

test("maybe outdated recommendation: amber coin rim and card; watched alert chip", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  const row = assets.locator("tr.rowlink", { hasText: "GLBA" }).first();
  await expect(row.locator(".avw[data-fresh='maybe']")).toHaveCount(1);
  await expect(row.locator(".c-hint .hint.review")).toHaveText("sprawdź rekomendację");
  await assets.getByRole("button", { name: /^Obserwowane/ }).click();
  const watched = assets.locator("tr.rowlink", { hasText: "DMSE" }).first();
  await expect(watched.locator(".c-hint .hint.review")).toHaveText(/^alert: /);
  await assets.getByRole("button", { name: /^Portfel/ }).click();
  await row.click();
  const rec = page.locator(".adrawer .w.recw.maybe");
  await expect(rec).toBeVisible();
  await expect(rec.locator(".tag.warn")).toHaveText("może być nieaktualna");
  await expect(rec.locator(".rsn li")).not.toHaveCount(0);
});
