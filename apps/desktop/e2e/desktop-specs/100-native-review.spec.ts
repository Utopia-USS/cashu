import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";
import { readNativeReview } from "../review-support.ts";

const cardHeadings: Readonly<Record<string, string>> = {
  world: "Świat",
  sectors: "Sektory",
  positions: "Pozycje",
  events: "Wydarzenia",
  ideas: "Okazje",
  calendar: "Kalendarz",
  decide: "Do decyzji",
};

test("native Review preserves its seven-card session, writes actual owner outcomes and saves/undoes authoritative review", async () => {
  const repo = process.env.E2E_REPO,
    dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("generated native demo is absent");
  await restoreNativeBaseline(dataDir);
  const screenshot = process.env.E2E_REVIEW_SCREENSHOT ?? join(dataDir, "native-review.png");
  const worldScreenshot = screenshot.replace(/\.png$/u, "-world.png");
  const host: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      join(repo, "tools/node-ts/resolveTs.ts"),
      join(repo, "apps/host/src/testing/seedOverviewDemo.ts"),
      "serve",
    ],
    { env: { ...process.env, CASHU_E2E_REVIEW: "1" }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  host.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await until(
      () =>
        (existsSync(join(dataDir, "overview-ready")) &&
          readFileSync(join(dataDir, "overview-ready"), "utf8").trim() === String(host.pid)) ||
        host.exitCode !== null,
    );
    expect(host.exitCode, errors).toBeNull();
    app = await launchDesktop({ dataDir });
    const { page } = await dashboardWindow(app);
    await setPrivacy(page, false);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    await expect(page.getByTestId("native-portfolio")).toBeVisible();
    const vault = await page.evaluate(() =>
      new URLSearchParams(location.hash.split("?")[1] ?? "").get("vault"),
    );
    if (!vault) throw new Error("generated native vault selection absent");
    const before = await readNativeReview(dataDir, vault);
    const candidateId = before.ideas[0]?.id;
    expect(candidateId).toBeDefined();
    expect(before.cards).toEqual([
      "world",
      "sectors",
      "positions",
      "events",
      "ideas",
      "calendar",
      "decide",
    ]);
    await page
      .getByRole("region", { name: "Przegląd inwestycji", exact: true })
      .getByRole("button")
      .first()
      .click();
    const deck = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("button", { name: "Zamknij bez zapisu", exact: true }) });
    await expect(deck.getByRole("heading", { name: "Świat", exact: true })).toBeVisible();
    await page.screenshot({ path: worldScreenshot, fullPage: true });
    await deck.getByRole("button", { name: "Notatka dla agenta", exact: true }).click();
    const note = page.getByRole("dialog", { name: "Notatka dla agenta", exact: true });
    await note
      .getByRole("textbox", { name: "Notatka dla agenta", exact: true })
      .fill("Synthetic Review100 agent agenda");
    await note.getByRole("button", { name: "Zachowaj notatkę", exact: true }).click();
    await deck.getByRole("button", { name: "Do sprawdzenia", exact: true }).click();
    await expect(deck.getByRole("heading", { name: "Sektory", exact: true })).toBeVisible();
    await deck.getByRole("button", { name: "Cofnij kartę", exact: true }).click();
    await deck.getByRole("button", { name: "Notatka dla agenta", exact: true }).click();
    await expect(note.getByRole("textbox")).toHaveValue("Synthetic Review100 agent agenda");
    await note.getByRole("button", { name: "Anuluj", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    await expect(deck.getByRole("heading", { name: "Pozycje", exact: true })).toBeVisible();
    await deck.getByRole("button", { name: "Szczegóły", exact: true }).click();
    const movers = deck.locator('[aria-label="Pozycje"]');
    await movers.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(movers).toContainText(before.movers.all.at(-1)?.label ?? "missing");
    expect(await movers.locator("[data-index]").count()).toBeLessThan(50);
    await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    await expect(deck.getByRole("heading", { name: "Wydarzenia", exact: true })).toBeVisible();
    await deck.getByRole("button", { name: "Pełna notatka", exact: true }).first().click();
    await expect(
      page.getByText("Synthetic review earnings margin contracts", { exact: true }).last(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Zamknij", exact: true }).last().click();
    await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    await expect(deck.getByRole("heading", { name: "Okazje", exact: true })).toBeVisible();
    await deck.getByRole("button", { name: "Obserwuj", exact: true }).first().click();
    await expect(
      deck.getByRole("button", { name: "Cofnij zmianę kandydata", exact: true }),
    ).toBeVisible();
    expect((await readNativeReview(dataDir, vault)).ideas.map((row) => row.id)).not.toContain(
      candidateId,
    );
    await deck.getByRole("button", { name: "Cofnij zmianę kandydata", exact: true }).click();
    await expect(deck.getByRole("button", { name: "Obserwuj", exact: true }).first()).toBeVisible();
    expect((await readNativeReview(dataDir, vault)).ideas.map((row) => row.id)).toContain(
      candidateId,
    );
    await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    await expect(deck.getByRole("heading", { name: "Kalendarz", exact: true })).toBeVisible();
    await expect(deck).toContainText("Synthetic calendar release");
    await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    await expect(deck.getByRole("heading", { name: "Do decyzji", exact: true })).toBeVisible();
    await deck.getByRole("button", { name: "Bez zmian", exact: true }).first().click();
    await expect(deck).toContainText("Zapisane wybory");
    await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    await expect(deck.getByRole("heading", { name: "Podsumowanie", exact: true })).toBeVisible();
    await expect(deck).toContainText("Synthetic Review100 agent agenda");
    await deck
      .getByRole("textbox", { name: "Notatka końcowa", exact: true })
      .fill("Synthetic Review100 closing note");
    await deck.getByRole("button", { name: "Zakończ przegląd", exact: true }).click();
    await expect(deck).toHaveCount(0);
    const saved = await readNativeReview(dataDir, vault);
    expect(saved.last?.notes).toBe("Synthetic Review100 closing note");
    expect(saved.last?.stats.source).toBe("app");
    expect(saved.last?.stats.session).toBeDefined();
    expect(saved.last?.stats.decisions_since_last_review).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Cofnij zapis przeglądu", exact: true }).click();
    await expect(deck.getByRole("textbox", { name: "Notatka końcowa", exact: true })).toHaveValue(
      "Synthetic Review100 closing note",
    );
    await page.screenshot({ path: screenshot, fullPage: true });
    process.stdout.write(`Review screenshots: ${worldScreenshot} ${screenshot}\n`);
    expect((await readNativeReview(dataDir, vault)).last).toBeNull();
    // The open native dialog intercepts pointer input. Dispatch the external shell
    // checkbox event to prove it invalidates the active modal and hides the deck.
    const privacy = page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true });
    await privacy.dispatchEvent("click");
    await expect(privacy).toBeChecked();
    await expect(deck).toHaveCount(0);
    await setPrivacy(page, false);
    await expect(deck.getByRole("heading", { name: "Świat", exact: true })).toBeVisible();
    const fresh = await readNativeReview(dataDir, vault);
    for (const card of fresh.cards) {
      await expect(
        deck.getByRole("heading", { name: cardHeadings[card], exact: true }),
      ).toBeVisible();
      await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    }
    await expect(deck.getByRole("textbox", { name: "Notatka końcowa", exact: true })).toHaveValue(
      "",
    );
    await expect(deck).not.toContainText("Synthetic Review100 agent agenda");
    await deck
      .getByRole("textbox", { name: "Notatka końcowa", exact: true })
      .fill("Synthetic active other vault draft");
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Piotr" }, { force: true });
    await expect(deck).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Przegląd inwestycji", exact: true })
      .getByRole("button")
      .first()
      .click();
    for (const _card of (await readNativeReview(dataDir, vault)).cards)
      await deck.getByRole("button", { name: "Jasne, dalej", exact: true }).click();
    await expect(deck.getByRole("textbox", { name: "Notatka końcowa", exact: true })).toHaveValue(
      "",
    );
  } finally {
    if (app) {
      await app.close().catch(() => {});
      await stopHost(dataDir).catch(() => {});
    }
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await until(() => host.exitCode !== null);
    }
  }
});
