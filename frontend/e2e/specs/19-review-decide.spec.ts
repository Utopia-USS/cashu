// Weekly review: "Do decyzji" closes the deck (the last card before the summary) and groups what waits by what it
// means (risks, opportunities, to review, in progress, to fix), one item per subject with a sentence. After a
// review closed by an earlier spec nothing is new, so the card may be skipped: the summary then says why.
import { ANNA, expect, go, test } from "../fixtures";

test("Do decyzji is the last card, grouped, one sentence per subject", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("button", { name: /^Przegląd tygodnia/ }).click();
  const review = page.getByRole("dialog", { name: "Przegląd tygodnia" });
  await expect(review.getByText("Czy świat się wali")).toBeVisible();
  const top = review.locator(".rd-card.top");
  const summary = review.getByLabel("Notatka z przeglądu");
  let decideWasLast = false;
  let seen = false;
  for (let k = 0; k < 10 && !(await summary.isVisible()); k++) {
    seen = await top.locator(".eyebrow", { hasText: "Do decyzji" }).isVisible();
    if (seen) {
      expect(await top.locator(".rd-dec .grp").count()).toBeGreaterThan(0);
      expect(await top.locator(".rd-dec .it").count()).toBeLessThanOrEqual(7);
      for (const w of await top.locator(".rd-dec .it .w").allInnerTexts()) expect(w.trim().length).toBeGreaterThan(0);
    }
    await review.getByRole("button", { name: "Jasne, dalej" }).click();
    await page.waitForTimeout(350);
    decideWasLast = seen;
  }
  await expect(summary).toBeVisible();
  if (decideWasLast) return;
  // never shown: skipped with its reason on the summary
  await expect(review.locator(".rd-hint", { hasText: "Do decyzji (nic nie czeka na decyzję)" })).toBeVisible();
});
