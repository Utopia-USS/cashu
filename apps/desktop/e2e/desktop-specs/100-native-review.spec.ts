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

// The legacy deck (ab24ab6 ReviewDeck): the top card carries `data-card`, its eyebrow the card's title.
const cardTitles: Readonly<Record<string, string>> = {
  world: "Czy świat się wali",
  sectors: "Sektory",
  positions: "Pozycje: góra i dół",
  events: "Wydarzenia tygodnia",
  ideas: "Okazje spoza portfela",
  calendar: "Kalendarz 14 dni",
  decide: "Do decyzji",
};

test("the review deck walks its seven cards, writes actual owner outcomes and saves/undoes the authoritative review", async () => {
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
    // The hero's round review button (old ReviewButton): "<name> · <n> kart".
    const reviewButton = page.getByRole("button", { name: / · \d+ kart[ay]?$/u });
    await reviewButton.click();
    const deck = page.getByRole("dialog").filter({
      has: page.getByRole("button", { name: "Zamknij przegląd bez zapisu", exact: true }),
    });
    const card = (id: string) => deck.locator(`[data-card="${id}"]`);
    const keep = deck.getByRole("button", { name: "Jasne, dalej", exact: true });
    await expect(card("world")).toBeVisible();
    await expect(card("world")).toContainText(cardTitles.world ?? "");
    await page.screenshot({ path: worldScreenshot, fullPage: true });
    // A note for the agent on the first card, flagged, then undone: the note stays with the card.
    await card("world").getByRole("button", { name: "+ Notka dla agenta", exact: true }).click();
    await card("world")
      .getByRole("textbox", { name: "Notka dla agenta", exact: true })
      .fill("Synthetic Review100 agent agenda");
    await deck.getByRole("button", { name: "Wróć do tego", exact: true }).click();
    await expect(card("sectors")).toBeVisible();
    await deck.getByRole("button", { name: "Cofnij", exact: true }).click();
    await expect(card("world")).toBeVisible();
    await expect(
      card("world").getByRole("textbox", { name: "Notka dla agenta", exact: true }),
    ).toHaveValue("Synthetic Review100 agent agenda");
    await keep.click();
    await expect(card("sectors")).toBeVisible();
    await keep.click();
    await expect(card("positions")).toBeVisible();
    await card("positions").getByRole("button", { name: "Czytaj więcej", exact: true }).click();
    expect(await card("positions").locator("li").count()).toBeGreaterThan(0);
    await keep.click();
    await expect(card("events")).toBeVisible();
    await card("events").getByRole("button", { name: "Czytaj więcej", exact: true }).click();
    await card("events")
      .getByRole("button", { name: "pełna notatka →", exact: true })
      .first()
      .click();
    const sheet = page.getByRole("dialog").filter({ has: page.getByRole("heading", { level: 3 }) });
    await expect(sheet).toContainText("Synthetic review earnings margin contracts");
    await sheet.getByRole("button", { name: "Zamknij", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await keep.click();
    await expect(card("ideas")).toBeVisible();
    await card("ideas").getByRole("button", { name: "Obserwuj", exact: true }).first().click();
    await expect(card("ideas")).toContainText("✓ obserwuję");
    await expect
      .poll(async () => (await readNativeReview(dataDir, vault)).ideas.map((row) => row.id))
      .not.toContain(candidateId);
    // The candidate's undo sits in the toast (old research actions).
    await page
      .getByRole("region", { name: "Powiadomienia" })
      .getByRole("button", { name: "Cofnij", exact: true })
      .click();
    await expect
      .poll(async () => (await readNativeReview(dataDir, vault)).ideas.map((row) => row.id))
      .toContain(candidateId);
    await keep.click();
    await expect(card("calendar")).toBeVisible();
    await expect(card("calendar")).toContainText("Synthetic calendar release");
    await keep.click();
    await expect(card("decide")).toBeVisible();
    await card("decide").getByRole("button", { name: "Bez zmian", exact: true }).first().click();
    await expect(card("decide")).toContainText("✓ Bez zmian");
    await keep.click();
    await expect(card("summary")).toBeVisible();
    await expect(card("summary")).toContainText("Synthetic Review100 agent agenda");
    await card("summary")
      .getByRole("textbox", { name: "Notatka z przeglądu", exact: true })
      .fill("Synthetic Review100 closing note");
    await card("summary").getByRole("button", { name: "Zamknij przegląd", exact: true }).click();
    await expect(deck).toHaveCount(0);
    const saved = await readNativeReview(dataDir, vault);
    expect(saved.last?.notes).toBe("Synthetic Review100 closing note");
    expect(saved.last?.stats.source).toBe("app");
    expect(saved.last?.stats.session).toBeDefined();
    expect(saved.last?.stats.decisions_since_last_review).toBeGreaterThan(0);
    // "cofnij" next to the review button (old `.rv-slot` undo): the review is gone, the deck opens again.
    await page.getByRole("button", { name: "cofnij", exact: true }).click();
    await expect(card("world")).toBeVisible();
    await page.screenshot({ path: screenshot, fullPage: true });
    process.stdout.write(`Review screenshots: ${worldScreenshot} ${screenshot}\n`);
    await expect.poll(async () => (await readNativeReview(dataDir, vault)).last).toBeNull();
    // Every card of a fresh deck, then the summary keeps the closing draft of this window.
    for (const id of before.cards) {
      await expect(card(id)).toContainText(cardTitles[id] ?? id);
      await keep.click();
    }
    await expect(
      card("summary").getByRole("textbox", { name: "Notatka z przeglądu", exact: true }),
    ).toHaveValue("Synthetic Review100 closing note");
    await deck.getByRole("button", { name: "Zamknij przegląd bez zapisu", exact: true }).click();
    await expect(deck).toHaveCount(0);
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
