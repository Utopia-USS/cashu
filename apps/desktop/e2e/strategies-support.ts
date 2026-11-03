/** Additional generated-demo documents only. Never called against a source dataset or installed app. */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
export async function seedNativeStrategyDocuments(dataDir: string) {
  const allowed = process.env.E2E_ROOT;
  if (!allowed || dataDir !== process.env.E2E_NATIVE_DATA_DIR)
    throw new Error("synthetic_strategy_root_required");
  const base = await realpath(allowed);
  const root = await realpath(join(dataDir, "profiles", "demo-anna"));
  const scope = relative(base, root);
  if (!scope || scope.startsWith("..") || scope.startsWith("/"))
    throw new Error("synthetic_strategy_root_required");
  const folder = join(root, "strategies", "native-reference");
  await mkdir(join(folder, "notes"), { recursive: true, mode: 0o700 });
  const files = [
    [
      "README.md",
      "---\ntitle: Synthetic reference\ndescription: Synthetic private description\n---\n# Synthetic reference\n\nRead-only reference prose.\n\n- [x] Review\n\n[safe](https://example.test) [blocked](javascript:alert)\n\n<script>synthetic()</script>\n",
    ],
    ["notes.yaml", "version: 1\nbase_currency: PLN\n"],
    ["empty.txt", ""],
    [
      "notes/long.txt",
      Array.from({ length: 140 }, (_, index) => `synthetic line ${index + 1}`).join("\n"),
    ],
  ] as const;
  for (const [path, text] of files) {
    try {
      await writeFile(join(folder, path), text, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await readFile(join(folder, path), "utf8")) !== text
      )
        throw error;
    }
  }
  return root;
}
