import { currentVault, expect, test } from "../electron-test.ts";
import { readHostQuery } from "../host-query.ts";
import { openNativeDemo } from "../native-baseline.ts";

type ReviewScreen = {
  cards: string[];
  ideas: { id: string }[];
  last: { notes: string | null; stats: Record<string, unknown> } | null;
};

// The deck (ab24ab6 ReviewDeck): the top card carries `data-card`.
test("the review deck walks its seven cards, writes owner outcomes and saves / undoes the review", async () => {
  const demo = await openNativeDemo({ env: { CASHU_E2E_REVIEW: "1" } });
  const { page, dataDir } = demo;
  try {
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    await expect(page.getByTestId("native-portfolio")).toBeVisible();
    const vault = currentVault(page);
    const readNativeReview = () =>
      readHostQuery<ReviewScreen>(dataDir, vault, "investments.review.screen", {
        today: new Date().toISOString().slice(0, 10),
        lang: "pl",
        open: true,
      });
    const before = await readNativeReview();
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
    await expect(card("world")).toContainText("Czy świat się wali");
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
      .poll(async () => (await readNativeReview()).ideas.map((row) => row.id))
      .not.toContain(candidateId);
    // The candidate's undo sits in the toast (old research actions).
    await page
      .getByRole("region", { name: "Powiadomienia" })
      .getByRole("button", { name: "Cofnij", exact: true })
      .click();
    await expect
      .poll(async () => (await readNativeReview()).ideas.map((row) => row.id))
      .toContain(candidateId);
    await keep.click();
    await expect(card("calendar")).toBeVisible();
    await expect(card("calendar")).toContainText("Synthetic calendar release");
    await keep.click();
    await expect(card("decide")).toBeVisible();
    // The seeded risk item: "Trzymam" is its held outcome (old reviewDeckLogic ACTIONS.risk).
    await card("decide").getByRole("button", { name: "Trzymam", exact: true }).first().click();
    await expect(card("decide")).toContainText("✓ Trzymam");
    await keep.click();
    await expect(card("summary")).toBeVisible();
    await expect(card("summary")).toContainText("Synthetic Review100 agent agenda");
    await card("summary")
      .getByRole("textbox", { name: "Notatka z przeglądu", exact: true })
      .fill("Synthetic Review100 closing note");
    await card("summary").getByRole("button", { name: "Zamknij przegląd", exact: true }).click();
    await expect(deck).toHaveCount(0);
    const saved = await readNativeReview();
    expect(saved.last?.notes).toBe("Synthetic Review100 closing note");
    expect(saved.last?.stats.source).toBe("app");
    expect(saved.last?.stats.session).toBeDefined();
    expect(saved.last?.stats.decisions_since_last_review).toBeGreaterThan(0);
    // "cofnij" next to the review button (old `.rv-slot` undo): the review is gone, the deck opens again.
    await page.getByRole("button", { name: "cofnij", exact: true }).click();
    await expect(card("world")).toBeVisible();
    await expect.poll(async () => (await readNativeReview()).last).toBeNull();
    await deck.getByRole("button", { name: "Zamknij przegląd bez zapisu", exact: true }).click();
    await expect(deck).toHaveCount(0);
  } finally {
    await demo.close();
  }
});
