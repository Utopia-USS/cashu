import { type Block, type Inline, parseMarkdown } from "@cashu/ui-logic/core/markdown";
import type { ReactNode } from "react";
import { S } from "./Strategies.strings.js";

function keyed<T>(values: readonly T[]) {
  const counts = new Map<string, number>();
  return values.map((value, position) => {
    const content = JSON.stringify(value);
    const occurrence = counts.get(content) ?? 0;
    counts.set(content, occurrence + 1);
    return { value, position, key: `${content}:${occurrence}` };
  });
}
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
        return <code key={key}>{node.v}</code>;
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
            className="text-accent underline"
          >
            {inline(node.c)}
          </a>
        ) : (
          <span key={key}>{inline(node.c)}</span>
        );
    }
    return null;
  });
}
function block(node: Block, key: number): ReactNode {
  switch (node.t) {
    case "h": {
      const Heading = `h${Math.min(node.level + 1, 6)}` as "h2";
      return (
        <Heading key={key} className="text-title">
          {inline(node.c)}
        </Heading>
      );
    }
    case "p":
      return <p key={key}>{inline(node.c)}</p>;
    case "hr":
      return <hr key={key} className="border-border" />;
    case "quote":
      return (
        <blockquote key={key} className="border-l border-border pl-4">
          {node.blocks.map(block)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={key} className="overflow-auto rounded-sm bg-surface-sunken p-3">
          <code>{node.v}</code>
        </pre>
      );
    case "list": {
      const items = keyed(node.items).map(({ value: item, key }) => (
        <li key={key}>
          {item.task !== null && (
            <input
              type="checkbox"
              aria-label={item.task ? S.taskDone : S.taskPending}
              checked={item.task}
              readOnly
              tabIndex={-1}
            />
          )}
          {item.blocks.map(block)}
        </li>
      ));
      return node.ordered ? (
        <ol key={key} start={node.start} className="list-decimal pl-6">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc pl-6">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={key} className="overflow-auto">
          <table>
            <thead>
              <tr>
                {keyed(node.head).map(({ value: cell, position: i, key }) => (
                  <th
                    key={key}
                    className="border-b border-border p-2"
                    style={{ textAlign: node.align[i] ?? undefined }}
                  >
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keyed(node.rows).map(({ value: row, key }) => (
                <tr key={key}>
                  {keyed(row).map(({ value: cell, position: j, key }) => (
                    <td
                      key={key}
                      className="border-b border-border p-2"
                      style={{ textAlign: node.align[j] ?? undefined }}
                    >
                      {inline(cell)}
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
  return <div className="space-y-4 break-words">{parseMarkdown(text).map(block)}</div>;
}
