/** Python `repr(str)` (the `!r` of f-strings): quoting and escapes as CPython. */

const NOT_PRINTABLE = /[\p{C}\p{Z}]/u;

/**
 * Python `repr(text)`: single quotes unless the text has `'` and no `"`; `\t \n \r`, backslash and the
 * quote escaped; other non-printable code points (`str.isprintable` false: categories C* and Z* except
 * the space) as `\xhh`, `\uhhhh` or `\Uhhhhhhhh`.
 */
export function pyReprStr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x7f) out += ch;
    else if (ch !== " " && NOT_PRINTABLE.test(ch)) {
      if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, "0")}`;
      else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
      else out += `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}
