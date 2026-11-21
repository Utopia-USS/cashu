// The CLI's small Rich-compatible repr highlighter. Patterns mirror the installed Python Rich API.
import { pyRegex } from "@cashu/domain";
export interface ConsoleStyle {
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly color?: number;
}
export interface ConsoleSpan {
  readonly start: number;
  readonly end: number;
  readonly style: ConsoleStyle;
}
const BOLD = { bold: true };
const NUMBER = { color: 36, bold: true, italic: false };
const NETWORK = { color: 92, bold: true };
const STYLES: Readonly<Record<string, ConsoleStyle>> = {
  tag_start: BOLD,
  tag_name: { color: 95, bold: true },
  tag_contents: { color: 39 },
  tag_end: BOLD,
  attrib_name: { color: 33, italic: false },
  attrib_value: { color: 35, italic: false },
  brace: BOLD,
  ipv4: NETWORK,
  ipv6: NETWORK,
  eui64: NETWORK,
  eui48: NETWORK,
  uuid: { color: 93, bold: false },
  call: { color: 35, bold: true },
  bool_true: { color: 92, italic: true },
  bool_false: { color: 91, italic: true },
  none: { color: 35, italic: true },
  ellipsis: { color: 33 },
  number_complex: NUMBER,
  number: NUMBER,
  path: { color: 35 },
  filename: { color: 95 },
  str: { color: 32, italic: false, bold: false },
  url: { color: 94, underline: true, italic: false, bold: false },
};
const PATTERNS = [
  String.raw`(?<tag_start><)(?<tag_name>[-\w.:|]*)(?<tag_contents>(?:.|\n)*)(?<tag_end>>)`,
  String.raw`(?<attrib_name>[\w_]{1,50})=(?<attrib_value>"?[\w_]+"?)?`,
  String.raw`(?<brace>[\[\]{}()])`,
  [
    String.raw`(?<ipv4>[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})`,
    "(?<ipv6>([A-Fa-f0-9]{1,4}::?){1,7}[A-Fa-f0-9]{1,4})",
    String.raw`(?<eui64>(?:[0-9A-Fa-f]{1,2}-){7}[0-9A-Fa-f]{1,2}|(?:[0-9A-Fa-f]{1,2}:){7}[0-9A-Fa-f]{1,2}|(?:[0-9A-Fa-f]{4}\.){3}[0-9A-Fa-f]{4})`,
    String.raw`(?<eui48>(?:[0-9A-Fa-f]{1,2}-){5}[0-9A-Fa-f]{1,2}|(?:[0-9A-Fa-f]{1,2}:){5}[0-9A-Fa-f]{1,2}|(?:[0-9A-Fa-f]{4}\.){2}[0-9A-Fa-f]{4})`,
    "(?<uuid>[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})",
    String.raw`(?<call>[\w.]*?)\(`,
    String.raw`\b(?<bool_true>True)\b|\b(?<bool_false>False)\b|\b(?<none>None)\b`,
    String.raw`(?<ellipsis>\.\.\.)`,
    String.raw`(?<number_complex>(?<!\w)(?:\-?[0-9]+\.?[0-9]*(?:e[-+]?\d+?)?)(?:[-+](?:[0-9]+\.?[0-9]*(?:e[-+]?\d+)?))?j)`,
    String.raw`(?<number>(?<!\w)\-?[0-9]+\.?[0-9]*(e[-+]?\d+?)?\b|0x[0-9a-fA-F]*)`,
    String.raw`(?<path>\B(/[-\w._+]+)*\/)(?<filename>[-\w._+]*)?`,
    String.raw`(?<![\\\w])(?<str>b?'''.*?(?<!\\)'''|b?'.*?(?<!\\)'|b?""".*?(?<!\\)"""|b?".*?(?<!\\)")`,
    "(?<url>(file|https|http|ws|wss)://[-0-9a-zA-Z$_+!`(),.?/;:&=%#~@]*)",
  ].join("|"),
].map((pattern) => pyRegex(pattern, "gd"));
export function highlightConsole(text: string): ConsoleSpan[] {
  const spans: ConsoleSpan[] = [];
  for (const pattern of PATTERNS)
    for (const match of text.matchAll(pattern)) {
      for (const [name, indices] of Object.entries(match.indices?.groups ?? {})) {
        const style = STYLES[name];
        if (indices !== undefined && style !== undefined && indices[1] > indices[0])
          spans.push({ start: indices[0], end: indices[1], style });
      }
    }
  return spans;
}
