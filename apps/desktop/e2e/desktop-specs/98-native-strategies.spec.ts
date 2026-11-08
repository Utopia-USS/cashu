import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, rewriteHash, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

/** A strategy document with an unsafe link and a script, in Demo Anna's strategies folder. */
async function seedDocument(dataDir: string): Promise<void> {
  const folder = join(dataDir, "profiles", "demo-anna", "strategies", "native-reference");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(
    join(folder, "README.md"),
    "---\ntitle: Synthetic reference\ndescription: Synthetic private description\n---\n# Synthetic reference\n\nRead-only reference prose.\n\n[safe](https://example.test) [blocked](javascript:alert)\n\n<script>synthetic()</script>\n",
    { mode: 0o600, flag: "wx" },
  );
}

test("Strategies renders a document without unsafe links or scripts and hides its prose in privacy mode", async () => {
  const demo = await openNativeDemo({ prepare: seedDocument });
  const { page } = demo;
  try {
    await rewriteHash(page, /\/overview(?:\?.*)?$/u, "/investments.strategies");
    const tree = page.getByRole("navigation", { name: "Strategie i ich pliki", exact: true });
    await tree.getByRole("button", { name: /^Synthetic reference/ }).click();
    await expect(page.getByText("Read-only reference prose.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "safe", exact: true })).toHaveAttribute(
      "href",
      "https://example.test",
    );
    await expect(page.getByRole("link", { name: "blocked", exact: true })).toHaveCount(0);
    await expect(page.locator("script").filter({ hasText: "synthetic()" })).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true }).click();
    await expect(page.getByText("Synthetic reference", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Synthetic private description", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Read-only reference prose.", { exact: true })).toHaveCount(0);
  } finally {
    await demo.close();
  }
});
