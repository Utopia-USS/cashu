import { describe, expect, it } from "vitest";
import { listFiles, readRepoFile, TEST_FILE } from "../repo.ts";
import { findRawStyles } from "./rawStyles.ts";

describe("findRawStyles (detector)", () => {
  it("flags raw colors, spacing and type values and Tailwind escapes", () => {
    const src = [
      'const a = { color: "#1a2b3c" };',
      "const b = { backgroundColor: rgba(0, 0, 0, 0.5) };",
      "const c = { padding: 12, fontSize: 14.5 };",
      'const d = { marginTop: "8px" };',
      'const e = <div className="p-[13px] bg-[#fff]" />;',
      'const f = <div className="bg-red-500 text-white" />;',
    ].join("\n");
    expect(findRawStyles(src).map((h) => `${h.line}:${h.kind}`)).toEqual([
      "1:hex color",
      "2:color function",
      "3:numeric spacing / type",
      "4:unit spacing / type",
      "5:hex color",
      "5:tailwind arbitrary value",
      "6:tailwind raw palette",
    ]);
  });

  it("accepts token references, zero and comments", () => {
    const src = [
      "const a = css.create({ root: { gap: space.md, color: color.text.primary } });",
      "const b = { padding: 0, margin: theme.space[2] };",
      'const c = <div className="bg-surface text-muted p-4 gap-2" />;',
      "// legacy: #ff0000 and padding: 12 are fine in a comment",
      'const d = { color: "var(--color-text-primary)" };',
    ].join("\n");
    expect(findRawStyles(src)).toEqual([]);
  });
});

describe("guard: app UI code uses tokens, not raw style values", () => {
  const files = listFiles(["apps"], /\.tsx$/).filter((f) => !TEST_FILE.test(f));

  it(`no raw color / spacing / type literals in apps/**/*.tsx (${files.length} files)`, () => {
    const hits = files.flatMap((f) =>
      findRawStyles(readRepoFile(f)).map((h) => `${f}:${h.line} ${h.kind}: ${h.text}`),
    );
    expect(
      hits,
      `Raw style values in app code. Use a token (CSS variable / theme role) or a packages/ui component:\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
