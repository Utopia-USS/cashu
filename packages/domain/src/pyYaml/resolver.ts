/**
 * PyYAML's `Resolver` (`resolver.py`) as `SafeLoader` uses it: the YAML 1.1 implicit resolvers in
 * registration order, dispatched on the first code point, applied to plain (implicit) scalars. No
 * path resolvers are registered, so collections always get the default tags.
 *
 * The patterns are Python's `re.X` patterns with the insignificant whitespace removed; Python's `$`
 * also matches before a trailing newline, hence `\n?$`.
 */

const DEFAULT_SCALAR_TAG = "tag:yaml.org,2002:str";
export const DEFAULT_SEQUENCE_TAG = "tag:yaml.org,2002:seq";
export const DEFAULT_MAPPING_TAG = "tag:yaml.org,2002:map";

type Resolver = readonly [tag: string, pattern: RegExp, first: readonly string[]];

const DIGITS = [..."0123456789"];

/** `Resolver.add_implicit_resolver` calls, in order. */
const IMPLICIT_RESOLVERS: readonly Resolver[] = [
  [
    "tag:yaml.org,2002:bool",
    /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)\n?$/,
    [..."yYnNtTfFoO"],
  ],
  [
    "tag:yaml.org,2002:float",
    /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\n?$/,
    [..."-+0123456789."],
  ],
  [
    "tag:yaml.org,2002:int",
    /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)\n?$/,
    [..."-+0123456789"],
  ],
  ["tag:yaml.org,2002:merge", /^(?:<<)\n?$/, ["<"]],
  ["tag:yaml.org,2002:null", /^(?:~|null|Null|NULL|)\n?$/, ["~", "n", "N", ""]],
  [
    "tag:yaml.org,2002:timestamp",
    /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)\n?$/,
    DIGITS,
  ],
  ["tag:yaml.org,2002:value", /^(?:=)\n?$/, ["="]],
  // Documentation only in PyYAML (a plain scalar cannot start with these), but reachable through
  // the non-specific tag `!` on a quoted scalar.
  ["tag:yaml.org,2002:yaml", /^(?:!|&|\*)\n?$/, [..."!&*"]],
];

/** `yaml_implicit_resolvers`: first code point (`""` for the empty scalar) to resolvers in order. */
const BY_FIRST: ReadonlyMap<string, readonly (readonly [string, RegExp])[]> = (() => {
  const table = new Map<string, (readonly [string, RegExp])[]>();
  for (const [tag, pattern, first] of IMPLICIT_RESOLVERS) {
    for (const ch of first) {
      const list = table.get(ch) ?? [];
      list.push([tag, pattern]);
      table.set(ch, list);
    }
  }
  return table;
})();

/** `resolve(ScalarNode, value, implicit)` for a scalar without a specific tag. */
export function resolveScalar(value: string, implicit: readonly [boolean, boolean]): string {
  if (implicit[0]) {
    const first = value === "" ? "" : String.fromCodePoint(value.codePointAt(0) ?? 0);
    for (const [tag, pattern] of BY_FIRST.get(first) ?? []) {
      if (pattern.test(value)) return tag;
    }
  }
  return DEFAULT_SCALAR_TAG;
}
