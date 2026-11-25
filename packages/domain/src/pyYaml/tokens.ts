/**
 * PyYAML's `tokens.py`: the scanner's tokens. The discriminant is the token class's `id`, the text
 * the parser's error messages quote (`expected <block end>, but found '<scalar>'`).
 */

import type { YamlMark } from "./errors.js";

/** Tokens without a value. */
export type SimpleTokenId =
  | "<stream start>"
  | "<stream end>"
  | "<document start>"
  | "<document end>"
  | "<block sequence start>"
  | "<block mapping start>"
  | "<block end>"
  | "["
  | "{"
  | "]"
  | "}"
  | "?"
  | ":"
  | "-"
  | ",";

/** `ScalarToken.style`: `null` for plain, else the quote or block indicator. */
export type ScalarStyle = null | "'" | '"' | "|" | ">";

/** `DirectiveToken.value`: `(major, minor)` for `%YAML`, `(handle, prefix)` for `%TAG`, else `None`. */
export type DirectiveValue =
  | null
  | { readonly kind: "yaml"; readonly major: number; readonly minor: number }
  | { readonly kind: "tag"; readonly handle: string; readonly prefix: string };

interface Marks {
  readonly startMark: YamlMark;
  readonly endMark: YamlMark;
}

export type Token =
  | (Marks & { readonly id: SimpleTokenId })
  | (Marks & { readonly id: "<directive>"; readonly name: string; readonly value: DirectiveValue })
  | (Marks & { readonly id: "<alias>" | "<anchor>"; readonly value: string })
  /** `(handle, suffix)`; `handle` is `None` for a verbatim tag and for a lone `!`. */
  | (Marks & { readonly id: "<tag>"; readonly value: readonly [string | null, string] })
  | (Marks & {
      readonly id: "<scalar>";
      readonly value: string;
      readonly plain: boolean;
      readonly style: ScalarStyle;
    });

export type TokenId = Token["id"];
