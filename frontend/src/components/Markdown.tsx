// Renders the tree of core/markdown.ts as React elements (no HTML strings). Styles: `.md` in
// modules/investments/v2/strategies.css (its only user so far).
import { useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../core/markdown";

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, k) => {
    if (typeof n === "string") return n;
    switch (n.t) {
      case "b": return <strong key={k}>{inline(n.c)}</strong>;
      case "i": return <em key={k}>{inline(n.c)}</em>;
      case "s": return <s key={k}>{inline(n.c)}</s>;
      case "code": return <code key={k}>{n.v}</code>;
      case "br": return <br key={k} />;
      case "a": return n.href
        ? <a key={k} href={n.href} target="_blank" rel="noreferrer noopener">{inline(n.c)}</a>
        : <span key={k} className="md-badlink">{inline(n.c)}</span>;
    }
  });
}

function block(b: Block, k: number): ReactNode {
  switch (b.t) {
    case "h": {
      const H = `h${Math.min(b.level + 1, 6)}` as "h2"; // the page owns h1
      return <H key={k} className={`md-h${b.level}`}>{inline(b.c)}</H>;
    }
    case "p": return <p key={k}>{inline(b.c)}</p>;
    case "hr": return <hr key={k} />;
    case "quote": return <blockquote key={k}>{b.blocks.map(block)}</blockquote>;
    case "code": return <pre key={k} data-lang={b.lang || undefined}><code>{b.v}</code></pre>;
    case "list": {
      const items = b.items.map((it, j) => (
        <li key={j} className={it.task == null ? undefined : "md-task"}>
          {it.task != null && <input type="checkbox" checked={it.task} readOnly tabIndex={-1} />}
          {/* a one-paragraph item renders inline, as in a tight list */}
          {it.blocks.length === 1 && it.blocks[0].t === "p" ? inline(it.blocks[0].c) : it.blocks.map(block)}
        </li>
      ));
      return b.ordered ? <ol key={k} start={b.start !== 1 ? b.start : undefined}>{items}</ol> : <ul key={k}>{items}</ul>;
    }
    case "table": return (
      <div key={k} className="md-table">
        <table>
          <thead><tr>{b.head.map((c, j) => <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>{inline(c)}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{blocks.map(block)}</div>;
}
