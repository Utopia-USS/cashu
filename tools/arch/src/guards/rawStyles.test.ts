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

  it("flags numeric arbitrary values behind variants and the calc / var-fallback escapes", () => {
    const src = [
      'const a = <div className="max-[861px]:grid-cols-1" />;',
      'const b = <div className="@max-[1000px]:hidden!" />;',
      'const c = <div className="min-[40rem]:p-2 @min-[30rem]:p-2" />;',
      'const d = <div className="hover:p-[13px]" />;',
      'const e = <div className="max-[calc(861px)]:gap-4" />;',
      'const f = <div className="tracking-[var(--tracking-section,.07em)]" />;',
      'const g = <div className="leading-[var(--leading-row,1.3)]" />;',
      'const h = <div className="grid-cols-[minmax(0,320px)_1fr] -top-[5.5px]" />;',
      'const i = <div className="max-w-[calc(64ch)]" />;',
      'const j = <div className="grid-cols-[1fr_320px]" />;',
    ].join("\n");
    expect(findRawStyles(src).map((h) => `${h.line}:${h.text}`)).toEqual([
      "1:max-[861px]",
      "2:@max-[1000px]",
      "3:min-[40rem]",
      "4:p-[13px]",
      "5:max-[calc(861px)]",
      "6:tracking-[var(--tracking-section,.07em)]",
      "7:leading-[var(--leading-row,1.3)]",
      "8:grid-cols-[minmax(0,320px)_1fr]",
      "9:max-w-[calc(64ch)]",
      "10:grid-cols-[1fr_320px]",
    ]);
  });

  it("accepts arbitrary values built from tokens", () => {
    const src = [
      'const a = <div className="grid-cols-[--spacing(30)_minmax(0,1fr)_auto] max-story:grid-cols-1" />;',
      'const b = <div className="@max-assets:hidden! max-w-measure tracking-section leading-row" />;',
      'const c = <div className="lg:grid-cols-[2fr_1fr] grid-cols-[minmax(0,5fr)_minmax(0,7fr)] origin-[center_90%]" />;',
      'const d = <div className="bg-[var(--color-accent)] aria-[invalid=true]:border-negative" />;',
      'const e = <div className="max-wide:[&_td:not(:first-child)]:whitespace-nowrap" />;',
    ].join("\n");
    expect(findRawStyles(src)).toEqual([]);
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
