// What the owner's strategy says about a fall, for the alert sheet: the synced main `strategy.md` (the
// latest strategy version; the phone has no strategy files) and its first blockquote under a heading
// about drawdowns ("Drawdowns", "Spadki"). The strategy's YAML has no free text for it, so without such
// a quote the sheet shows no strategy line.

import { latestStrategyVersion } from "@cashu/store/investments/screen-sources";
import { defineQuery } from "@cashu/store/query";
import {
  type Block,
  type Inline,
  parseMarkdown,
  stripFrontmatter,
} from "@cashu/ui-logic/core/markdown";

/** The synced main strategy text, or null before the Mac saved a strategy version. */
export const strategyMarkdown = defineQuery({
  id: "mobile.investments.strategyMarkdown",
  run(read) {
    return latestStrategyVersion(read)?.mdText ?? null;
  },
});

/** Heading words that name the drawdown section (English and Polish strategy files). */
const DRAWDOWN = /drawdown|spad/i;

function inlineText(parts: readonly Inline[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.t === "code") return part.v;
      if (part.t === "br") return " ";
      return inlineText(part.c);
    })
    .join("");
}

function blocksText(blocks: readonly Block[]): string {
  return blocks
    .flatMap((block) => {
      switch (block.t) {
        case "h":
        case "p":
          return [inlineText(block.c)];
        case "quote":
          return [blocksText(block.blocks)];
        case "list":
          return block.items.map((item) => blocksText(item.blocks));
        default:
          return [];
      }
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first blockquote under a heading about drawdowns, as one line; null without one. */
export function drawdownLine(markdown: string | null): string | null {
  if (markdown === null) return null;
  let inside = false;
  for (const block of parseMarkdown(stripFrontmatter(markdown))) {
    if (block.t === "h") inside = DRAWDOWN.test(inlineText(block.c));
    else if (inside && block.t === "quote") {
      const text = blocksText(block.blocks);
      if (text !== "") return text;
    }
  }
  return null;
}
