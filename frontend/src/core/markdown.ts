// A small Markdown parser for agent-written documents (the Strategie tab, docs/agents/strategies.md): headings,
// paragraphs, lists (nested by indent, task boxes), quotes, fenced code, tables, rules; inline bold, italic,
// strikethrough, code and links. It returns a tree that `Markdown.tsx` renders as React elements, never HTML
// strings, so a document cannot inject markup. Links keep only http(s) and mailto targets.

export type Inline =
  | string
  | { t: "b" | "i" | "s"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "a"; href: string | null; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem { task: boolean | null; blocks: Block[] }

export type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "code"; lang: string; v: string }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+-]*)/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** The document without a leading `---` frontmatter block (its fields feed the strategy list instead). */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, "");
}

export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

/** Inline markup of one paragraph's text. Unclosed markers stay literal. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;
    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_~[\]()#|!-]/.test(rest[1])) { buf += rest[1]; i += 2; continue; }
    if (rest[0] === "\n") { flush(); out.push({ t: "br" }); i += 1; continue; }
    if ((m = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/))) { flush(); out.push({ t: "code", v: m[2].trim() || m[2] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/))) {
      flush(); out.push({ t: "a", href: safeHref(m[2]), c: parseInline(m[1]) }); i += m[0].length; continue;
    }
    if ((m = rest.match(/^<(https?:\/\/[^>\s]+)>/))) { flush(); out.push({ t: "a", href: m[1], c: [m[1]] }); i += m[0].length; continue; }
    if ((m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/))) { flush(); out.push({ t: "b", c: parseInline(m[2]) }); i += m[0].length; continue; }
    if ((m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) { flush(); out.push({ t: "s", c: parseInline(m[1]) }); i += m[0].length; continue; }
    // `_` only at a word start, so snake_case names stay literal
    if ((m = rest.match(/^\*(?=[^\s*])([\s\S]*?[^\s*])\*/)) || ((i === 0 || /\W/.test(text[i - 1])) && (m = rest.match(/^_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/)))) {
      flush(); out.push({ t: "i", c: parseInline(m[1]) }); i += m[0].length; continue;
    }
    buf += rest[0];
    i += 1;
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const l = cell.startsWith(":"), r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "  ").length;
const isBlank = (line: string) => line.trim() === "";

function startsBlock(line: string): boolean {
  return HEADING.test(line) || FENCE.test(line) || HR.test(line) || BULLET.test(line) || /^\s{0,3}>/.test(line);
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      const close = new RegExp(`^\\s{0,3}${m[2][0]}{${m[2].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", lang: m[3], v: body.join("\n") });
      continue;
    }
    if ((m = line.match(HEADING))) { blocks.push({ t: "h", level: m[1].length, c: parseInline(m[2]) }); i++; continue; }
    if (HR.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ t: "quote", blocks: parseLines(body) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        const cells = splitRow(lines[i++]);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
      }
      blocks.push({ t: "table", align, head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    if ((m = line.match(BULLET))) {
      const base = indentOf(line);
      const ordered = /\d/.test(m[2]);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const bm = lines[i].match(BULLET);
        if (!bm || indentOf(lines[i]) !== base || /\d/.test(bm[2]) !== ordered) break;
        let first = bm[3];
        let task: boolean | null = null;
        const tm = first.match(/^\[([ xX])\]\s+/);
        if (tm) { task = tm[1] !== " "; first = first.slice(tm[0].length); }
        const body = [first];
        i++;
        // continuation: indented deeper than the marker, or a lazy paragraph line; a blank line ends the
        // item unless more indented content follows
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) {
            if (i + 1 < lines.length && !isBlank(lines[i + 1]) && indentOf(lines[i + 1]) > base) { body.push(""); i++; continue; }
            break;
          }
          if (indentOf(l) > base) { body.push(l.slice(Math.min(indentOf(l), base + 2))); i++; continue; }
          if (!startsBlock(l)) { body.push(l.trim()); i++; continue; }
          break;
        }
        items.push({ task, blocks: parseLines(body) });
        while (i < lines.length && isBlank(lines[i]) && i + 1 < lines.length && BULLET.test(lines[i + 1]) && indentOf(lines[i + 1]) === base) i++;
      }
      blocks.push({ t: "list", ordered, start: ordered ? parseInt(m[2], 10) : 1, items });
      continue;
    }
    const para: string[] = [line.trimStart()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])
      && !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) para.push(lines[i++].trimStart());
    // a hard break only where the source line ends with two spaces or a backslash
    const text = para.map((l, k) => (k === para.length - 1 ? l.trimEnd()
      : / {2,}$|\\$/.test(l) ? `${l.replace(/ +$|\\$/, "")}\n` : `${l.trimEnd()} `)).join("");
    blocks.push({ t: "p", c: parseInline(text) });
  }
  return blocks;
}

export function parseMarkdown(text: string): Block[] {
  return parseLines(stripFrontmatter(text).replace(/\r\n?/g, "\n").split("\n"));
}
