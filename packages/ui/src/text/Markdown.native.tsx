// The phone's Markdown reader (the Strategy tab's document): renders the block tree of
// `@cashu/ui-logic/core/markdown` (`parseMarkdown`) as React Native text, never as HTML. The types are
// restated structurally here (packages/ui does not import ui-logic); the parser's output fits them.
// Headings, paragraphs, lists (numbered, bulleted, task boxes), quotes, fenced code, a table as one row per
// line (first cell strong, the rest after it) and rules; inline bold, italic, strikethrough, code and
// links. A link opens in the system browser, and only an http(s) or mailto target (the parser already
// drops the others).
import type { ReactNode } from "react";
import { Linking, Text, View } from "react-native";

export type MarkdownInline =
  | string
  | { t: "b" | "i" | "s"; c: MarkdownInline[] }
  | { t: "code"; v: string }
  | { t: "a"; href: string | null; c: MarkdownInline[] }
  | { t: "br" };

export interface MarkdownListItem {
  task: boolean | null;
  blocks: MarkdownBlock[];
}

export type MarkdownBlock =
  | { t: "h"; level: number; c: MarkdownInline[] }
  | { t: "p"; c: MarkdownInline[] }
  | { t: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { t: "quote"; blocks: MarkdownBlock[] }
  | { t: "code"; lang: string; v: string }
  | {
      t: "table";
      align: ("left" | "center" | "right" | null)[];
      head: MarkdownInline[][];
      rows: MarkdownInline[][][];
    }
  | { t: "hr" };

export interface MarkdownProps {
  blocks: readonly MarkdownBlock[];
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

function openLink(href: string): void {
  if (SAFE_LINK.test(href)) void Linking.openURL(href);
}

/** Inline runs inside one Text; keys are positions in a static tree (the document never reorders). */
function inlines(runs: readonly MarkdownInline[], path: string): ReactNode[] {
  return runs.map((run, i) => {
    const key = `${path}.${i}`;
    if (typeof run === "string") return run;
    switch (run.t) {
      case "br":
        return "\n";
      case "code":
        return (
          <Text key={key} className="rounded-2xs bg-subtle font-mono text-fg">
            {run.v}
          </Text>
        );
      case "a":
        return run.href === null ? (
          <Text key={key}>{inlines(run.c, key)}</Text>
        ) : (
          <Text
            key={key}
            accessibilityRole="link"
            onPress={() => openLink(run.href as string)}
            className="text-accent underline"
          >
            {inlines(run.c, key)}
          </Text>
        );
      case "b":
        return (
          <Text key={key} className="font-bold">
            {inlines(run.c, key)}
          </Text>
        );
      case "i":
        return (
          <Text key={key} className="italic">
            {inlines(run.c, key)}
          </Text>
        );
      case "s":
        return (
          <Text key={key} className="line-through">
            {inlines(run.c, key)}
          </Text>
        );
    }
    return null;
  });
}

const headings = [
  "text-headline font-bold tracking-dense text-fg",
  "text-title font-heavy text-fg",
  "text-body font-heavy text-fg",
] as const;

function Block({ block, path }: { block: MarkdownBlock; path: string }) {
  switch (block.t) {
    case "h":
      return (
        <Text role="heading" className={`mt-1 ${headings[Math.min(block.level, 3) - 1]}`}>
          {inlines(block.c, path)}
        </Text>
      );
    case "p":
      return <Text className="text-body text-fg-secondary">{inlines(block.c, path)}</Text>;
    case "list":
      return (
        <View className="gap-1.5">
          {block.items.map((item, i) => {
            const marker =
              item.task !== null
                ? item.task
                  ? "☑"
                  : "☐"
                : block.ordered
                  ? `${block.start + i}.`
                  : "•";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static document's items never reorder.
              <View key={i} className="flex-row gap-2">
                <Text className="min-w-4 text-body text-fg-muted tabular-nums">{marker}</Text>
                <View className="min-w-0 flex-1 gap-1.5">
                  <Blocks blocks={item.blocks} path={`${path}.${i}`} />
                </View>
              </View>
            );
          })}
        </View>
      );
    case "quote":
      return (
        <View className="gap-2 border-l-2 border-border pl-3">
          <Blocks blocks={block.blocks} path={path} />
        </View>
      );
    case "code":
      return (
        <View className="rounded-tile bg-subtle p-3">
          <Text className="font-mono text-caption text-fg">{block.v}</Text>
        </View>
      );
    case "table":
      return (
        <View>
          {block.rows.map((row, r) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: a static document's rows never reorder.
              key={r}
              className={`gap-0.5 py-2 ${r === 0 ? "" : "border-t border-border"}`}
            >
              <Text className="text-body font-demi text-fg">
                {inlines(row[0] ?? [], `${path}.${r}.0`)}
              </Text>
              {row.slice(1).map((cell, c) => (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional.
                  key={c}
                  className="text-caption text-fg-muted"
                >
                  {block.head[c + 1] !== undefined && block.head[c + 1]?.length ? (
                    <Text className="font-medium">
                      {inlines(block.head[c + 1] ?? [], `${path}.h${c}`)}:{" "}
                    </Text>
                  ) : null}
                  {inlines(cell, `${path}.${r}.${c + 1}`)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    case "hr":
      return <View className="my-1 h-px bg-border" />;
  }
}

function Blocks({ blocks, path }: { blocks: readonly MarkdownBlock[]; path: string }) {
  return blocks.map((block, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a static document's blocks never reorder.
    <Block key={i} block={block} path={`${path}.${i}`} />
  ));
}

/** A document's blocks, 12 pt apart. */
export function Markdown({ blocks }: MarkdownProps) {
  return (
    <View className="gap-3">
      <Blocks blocks={blocks} path="m" />
    </View>
  );
}
