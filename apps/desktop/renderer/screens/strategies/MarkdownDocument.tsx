// Rendered Markdown (ab24ab6 components/Markdown.tsx with the `.md` rules of v2/strategies.css): the tree of
// ui-logic core/markdown.ts as React elements (no HTML strings), a readable document (72ch, 14.5px / 1.65).
// The old em-based margins are written as their pixel values at the element's size (`--spacing(n)`).
import { type Block, type Inline, parseMarkdown } from "@cashu/ui-logic/core/markdown";
import type { ReactNode } from "react";
import { S } from "./Strategies.strings.js";

/** Stable keys from the content (no index keys): equal siblings get an occurrence suffix. */
function keyed<T>(values: readonly T[]) {
  const counts = new Map<string, number>();
  return values.map((value, position) => {
    const content = JSON.stringify(value);
    const occurrence = counts.get(content) ?? 0;
    counts.set(content, occurrence + 1);
    return { value, position, key: `${content}:${occurrence}` };
  });
}

// `.md p, ul, ol, blockquote, pre, .md-table { margin: 0 0 .9em }`; inside a list item `.2em 0`.
const blockGap = (inItem: boolean) =>
  inItem ? "my-[--spacing(0.725)]" : "mt-0 mb-[--spacing(3.2625)]";
// `.md > :first-child { margin-top: 0 }`
const first = "first:mt-0";
const heading = "leading-row font-heavy text-fg normal-case tracking-normal";
const headings = {
  1: `${heading} mt-0 mb-3 text-4xl-minus`,
  2: `${heading} mt-[--spacing(7.6)] mb-[--spacing(2.375)] border-b border-border pb-1 text-xl`,
  3: `${heading} mt-[--spacing(6.4)] mb-2 text-base-plus`,
  4: `${heading} mt-[--spacing(5.8)] mb-[--spacing(1.8125)] text-md-plus`,
} as const;
const headingCls = (level: number) => headings[Math.min(level, 4) as 1 | 2 | 3 | 4];
const align = { left: "text-left", center: "text-center", right: "text-right" } as const;
const alignCls = (a: string | null | undefined) =>
  a === "left" || a === "center" || a === "right" ? align[a] : "text-left";
const cell = "border border-border px-2.5 py-1.25 align-top";

function inline(nodes: readonly Inline[]): ReactNode[] {
  return keyed(nodes).map(({ value: node, key }) => {
    if (typeof node === "string") return node;
    switch (node.t) {
      case "b":
        return <strong key={key}>{inline(node.c)}</strong>;
      case "i":
        return <em key={key}>{inline(node.c)}</em>;
      case "s":
        return <s key={key}>{inline(node.c)}</s>;
      case "code":
        return (
          <code key={key} className="rounded-2xs bg-chip px-1.25 py-px font-mono text-code">
            {node.v}
          </code>
        );
      case "br":
        return <br key={key} />;
      // Native shell's existing checked external-link policy handles navigation.
      case "a":
        return node.href ? (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-info underline"
          >
            {inline(node.c)}
          </a>
        ) : (
          <span key={key} className="underline decoration-dotted">
            {inline(node.c)}
          </span>
        );
    }
    return null;
  });
}

function block(node: Block, key: number | string, inItem = false): ReactNode {
  switch (node.t) {
    case "h": {
      const Heading = `h${Math.min(node.level + 1, 6)}` as "h2"; // the page owns h1
      return (
        <Heading key={key} className={`${headingCls(node.level)} ${first}`}>
          {inline(node.c)}
        </Heading>
      );
    }
    case "p":
      return (
        <p key={key} className={`${blockGap(inItem)} ${first}`}>
          {inline(node.c)}
        </p>
      );
    case "hr":
      return (
        <hr key={key} className={`my-[--spacing(5.8)] border-0 border-t border-border ${first}`} />
      );
    case "quote":
      return (
        <blockquote
          key={key}
          className={`${blockGap(inItem)} border-l-3 border-border px-3.5 py-0.5 text-fg-muted ${first}`}
        >
          {keyed(node.blocks).map(({ value, key: k }) => block(value, k))}
        </blockquote>
      );
    case "code":
      return (
        <pre
          key={key}
          data-lang={node.lang || undefined}
          className={`${blockGap(inItem)} overflow-x-auto rounded-control border border-border bg-subtle px-3.5 py-3 ${first}`}
        >
          <code className="p-0 font-mono text-xs-plus leading-normal">{node.v}</code>
        </pre>
      );
    case "list": {
      const items = keyed(node.items).map(({ value: item, key: k }) => (
        <li
          key={k}
          className={`my-[--spacing(0.725)] ${item.task == null ? "" : "-ml-[--spacing(4.7125)] list-none"}`}
        >
          {item.task != null && (
            <input
              type="checkbox"
              aria-label={item.task ? S.taskDone : S.taskPending}
              checked={item.task}
              readOnly
              tabIndex={-1}
              className="relative top-px mr-[--spacing(1.8125)]"
            />
          )}
          {/* a one-paragraph item renders inline, as in a tight list */}
          {item.blocks.length === 1 && item.blocks[0]?.t === "p"
            ? inline(item.blocks[0].c)
            : keyed(item.blocks).map(({ value, key: j }) => block(value, j, true))}
        </li>
      ));
      const list = `${blockGap(inItem)} pl-[--spacing(5.075)] ${first}`;
      return node.ordered ? (
        <ol
          key={key}
          start={node.start !== 1 ? node.start : undefined}
          className={`${list} list-decimal`}
        >
          {items}
        </ol>
      ) : (
        <ul key={key} className={`${list} list-disc`}>
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={key} className={`${blockGap(inItem)} overflow-x-auto ${first}`}>
          <table className="border-collapse text-sm-plus">
            <thead>
              <tr>
                {keyed(node.head).map(({ value: c, position: j, key: k }) => (
                  <th
                    key={k}
                    className={`${cell} bg-subtle font-strong text-fg normal-case tracking-normal ${alignCls(node.align[j])}`}
                  >
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keyed(node.rows).map(({ value: row, key: rk }) => (
                <tr key={rk}>
                  {keyed(row).map(({ value: c, position: j, key: k }) => (
                    <td key={k} className={`${cell} ${alignCls(node.align[j])}`}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function MarkdownDocument({ text }: { text: string }) {
  return (
    <div className="max-w-doc text-md-plus leading-prose text-fg wrap-anywhere">
      {keyed(parseMarkdown(text)).map(({ value, key }) => block(value, key))}
    </div>
  );
}
