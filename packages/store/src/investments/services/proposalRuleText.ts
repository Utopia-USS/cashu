// Pure proposal validation and rule-YAML assembly from investments_proposals.py.
import { floatRepr, pySplitlines, pyStrip } from "@cashu/domain";
import { BUILT_IN_KINDS } from "@cashu/domain/investments/rules";
import { issueText, type StrategyLoadResult } from "@cashu/domain/investments/strategy";
import { isPyMap, PyDate, type PyPlain, pyStr, safeLoadYaml } from "@cashu/domain/pyYaml";

export class StrategyProposalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StrategyProposalError";
  }
}
export interface InactiveRuleWarning {
  readonly code: "inactive_rule";
  readonly rule_id: string;
  readonly message: string;
}
const inactive = (result: StrategyLoadResult | null | undefined) =>
  new Set(result?.inactiveRules.map((r) => r.ruleId || `rules[${r.index}]`) ?? []);

export function checkResultingStrategy(
  result: StrategyLoadResult,
  before?: StrategyLoadResult | null,
  newRuleId?: string,
): InactiveRuleWarning[] {
  if (result.config === null && result.partial === null)
    throw new StrategyProposalError(
      "invalid_strategy",
      `the resulting strategy does not validate: ${result.issues
        .filter((i) => i.severity === "error")
        .map(issueText)
        .join("; ")
        .slice(0, 500)}`,
    );
  const now = inactive(result),
    old = inactive(before);
  if (newRuleId !== undefined && now.has(newRuleId)) {
    const own = result.inactiveRules.find((r) => r.ruleId === newRuleId);
    throw new StrategyProposalError(
      "rule_invalid",
      `the proposed rule ${newRuleId} does not validate: ${own?.issues.map(issueText).join("; ").slice(0, 500) ?? ""}`,
    );
  }
  const added = [...now].filter((id) => !old.has(id) && id !== newRuleId).sort();
  if (added.length !== 0)
    throw new StrategyProposalError(
      "rules_made_inactive",
      `the change makes rule(s) inactive: ${added.join(", ")}`,
    );
  return [...now].sort().map((rule_id) => ({
    code: "inactive_rule",
    rule_id,
    message: `rule ${rule_id} was already inactive before this change; fix it in strategy.yaml`,
  }));
}

function plain(value: unknown): PyPlain {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return value;
  if (typeof value === "number")
    return Number.isInteger(value) && Number.isFinite(value) ? BigInt(value) : value;
  if (value instanceof PyDate) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map)
    return new Map([...value].map(([key, item]) => [String(key), plain(item)]));
  if (typeof value === "object" && value !== null)
    return new Map(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  throw new StrategyProposalError("invalid", "rule parameters must be JSON values");
}
function wrapScalar(
  text: string,
  column: number,
  indent: number,
  width: number,
  singleQuoted = false,
): string {
  let result = "";
  const parts = text.split(/( +)/u);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (part === " " && column > width && (!singleQuoted || (i !== 1 && i !== parts.length - 2))) {
      result += `\n${" ".repeat(indent + 2)}`;
      column = indent + 2;
    } else {
      result += part;
      const lines = pySplitlines(part);
      column = /[\n\x85\u2028\u2029]/u.test(part)
        ? [...(lines.at(-1) ?? "")].length
        : column + [...part].length;
    }
  }
  return result;
}
function quoted(text: string, indent: number, column = indent, width = 80): string {
  const parsed = safeLoadYaml(text);
  if (
    text !== "" &&
    text.trim() === text &&
    ![...text].some((char) => {
      const cp = char.codePointAt(0) ?? 0;
      return cp <= 31 || cp === 127 || cp === 133 || cp === 8232 || cp === 8233;
    }) &&
    text !== "---" &&
    text !== "..." &&
    parsed.ok &&
    parsed.value === text
  )
    return wrapScalar(text, column, indent, width);
  if (
    [...text].some((char) => {
      const cp = char.codePointAt(0) ?? 0;
      return (
        cp <= 9 || (cp >= 11 && cp <= 31) || (cp >= 127 && cp <= 132) || (cp >= 134 && cp <= 159)
      );
    })
  )
    return JSON.stringify(text)
      .replace(/\\u00([0-9a-f]{2})/gu, (_all, hex: string) => `\\x${hex.toUpperCase()}`)
      .replace(/\\x00/gu, "\\0")
      .replace(/\\x07/gu, "\\a")
      .replace(/\\x0B/gu, "\\v")
      .replace(/\\x1B/gu, "\\e")
      .replace(/[\x7f-\x9f]/gu, (value) =>
        value === "\x85"
          ? "\\N"
          : `\\x${value.codePointAt(0)?.toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .replaceAll("\u2028", "\\L")
      .replaceAll("\u2029", "\\P");
  const continuation = " ".repeat(indent + 2);
  return `'${wrapScalar(
    text
      .replaceAll("'", "''")
      .replace(/\n+/gu, (run) => `${"\n".repeat(run.length + 1)}${continuation}`)
      .replace(/[\x85\u2028\u2029]/gu, (value) => `${value}${continuation}`),
    column + 1,
    indent,
    width,
    true,
  )}'`;
}
function scalar(value: PyPlain, indent: number, column = indent, width = 80): string | null {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (!Number.isFinite(value)) return value < 0 ? "-.inf" : ".inf";
    const repr = floatRepr(value);
    return (
      repr.includes("e") && !repr.split("e")[0]?.includes(".") ? repr.replace("e", ".0e") : repr
    ).replace(
      /e([+-])(\d+)$/,
      (_all, sign: string, digits: string) => `e${sign}${digits.padStart(2, "0")}`,
    );
  }
  if (typeof value === "string") return quoted(value, indent, column, width);
  if (value instanceof PyDate) return pyStr(value);
  if (isPyMap(value)) return value.size === 0 ? "{}" : null;
  return value.length === 0 ? "[]" : null;
}
function dump(value: PyPlain, indent = 0, width = 80): string {
  const pad = " ".repeat(indent),
    atom = scalar(value, indent, indent, width);
  if (atom !== null) return `${pad}${atom}\n`;
  if (isPyMap(value))
    return [...value]
      .map(([key, child]) => {
        const head = `${pad}${quoted(key, indent)}:`;
        const token = scalar(child, indent, [...head].length + 1, width);
        return token !== null
          ? `${head} ${token}\n`
          : `${head}\n${dump(child, Array.isArray(child) ? indent : indent + 2, width)}`;
      })
      .join("");
  return (value as readonly PyPlain[])
    .map((child) => {
      const token = scalar(child, indent, indent + 2, width);
      if (token !== null) return `${pad}- ${token}\n`;
      const lines = dump(child, indent + 2, width).split("\n");
      return `${pad}- ${lines[0]?.slice(indent + 2)}\n${lines.slice(1).join("\n")}`;
    })
    .join("");
}

export function renderProposalRule(entry: Readonly<Record<string, unknown>>, indent = ""): string {
  // Source _render_rule uses str.splitlines(), including its inherited Unicode-break normalization.
  return pySplitlines(dump([plain(entry)], 0, 1000))
    .map((line) => (line.trim() ? `${indent}${line}\n` : "\n"))
    .join("");
}
export function existingProposalRuleIds(yaml: string): Set<string> {
  const doc = safeLoadYaml(yaml);
  if (!doc.ok || !isPyMap(doc.value)) return new Set();
  const rules = doc.value.get("rules");
  if (!Array.isArray(rules)) return new Set();
  return new Set(
    rules.filter(isPyMap).flatMap((rule) => {
      const id = rule.get("id");
      return id !== undefined && truthy(id) ? [pyStr(id)] : [];
    }),
  );
}
export function mergeProposalRule(yaml: string, entry: Readonly<Record<string, unknown>>): string {
  const lines = pySplitlines(yaml);
  const start = lines.findIndex((line) => /^rules\s*:/u.test(line));
  if (start < 0)
    return `${yaml && !yaml.endsWith("\n") ? `${yaml}\n` : yaml}rules:\n${renderProposalRule(entry, "  ")}`;
  const rest = lines[start]?.split(":").slice(1).join(":").split("#")[0]?.trim() ?? "";
  if (rest === "" || rest === "[]") {
    if (rest === "[]") lines[start] = "rules:";
    let end = start + 1,
      last = start,
      indent: string | null = null;
    while (end < lines.length) {
      const line = lines[end] ?? "",
        stripped = line.trim();
      if (stripped && !stripped.startsWith("#")) {
        if (!/^[ \t-]/u.test(line)) break;
        if (indent === null && stripped.startsWith("- ")) indent = /^\s*/u.exec(line)?.[0] ?? "";
        last = end;
      }
      end += 1;
    }
    const rendered = pySplitlines(renderProposalRule(entry, indent ?? "  ").trimEnd());
    return `${[...lines.slice(0, last + 1), ...rendered, ...lines.slice(last + 1)].join("\n")}\n`;
  }
  const doc = safeLoadYaml(yaml);
  if (!doc.ok || !isPyMap(doc.value))
    throw new StrategyProposalError("invalid_strategy", "the current strategy has errors");
  const result = new Map(doc.value),
    old = result.get("rules");
  result.set("rules", [...(Array.isArray(old) ? old : []), plain(entry)]);
  return dump(result);
}

export function proposalRuleEntry(
  kindOrExpression: string,
  params: Readonly<Record<string, unknown>>,
  ids: ReadonlySet<string>,
) {
  const values = { ...params },
    meta: Record<string, unknown> = {};
  for (const key of ["id", "severity", "cooldown_days"])
    if (key in values) {
      meta[key] = values[key];
      delete values[key];
    }
  const text = pyStrip(kindOrExpression),
    builtin = (BUILT_IN_KINDS as readonly string[]).includes(text) && text !== "custom";
  const kind = builtin ? text : "custom";
  const when = "when" in values ? plain(values.when) : "";
  const expression = builtin ? null : text === "custom" ? (truthy(when) ? pyStr(when) : "") : text;
  let ruleParams: Record<string, unknown> = values;
  if (!builtin) {
    const scope = "scope" in values ? values.scope : "portfolio";
    delete values.scope;
    delete values.when;
    ruleParams = { scope, when: expression, ...values };
  }
  let id = "id" in meta && truthy(plain(meta.id)) ? pyStrip(pyStr(plain(meta.id))) : "";
  if (!id) {
    const base = `agent_${kind}`.replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
    let n = 1;
    while (ids.has(`${base}_${n}`)) n += 1;
    id = `${base}_${n}`;
  }
  if (ids.has(id))
    throw new StrategyProposalError(
      "rule_exists",
      `a rule with id ${id} already exists; choose another id`,
    );
  const entry: Record<string, unknown> = { id, kind };
  for (const key of ["severity", "cooldown_days"]) if (key in meta) entry[key] = meta[key];
  if (Object.keys(ruleParams).length !== 0) entry.params = ruleParams;
  return { entry, expression };
}

function truthy(value: PyPlain): boolean {
  if (value === null || value === false) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length !== 0;
  if (isPyMap(value)) return value.size !== 0;
  return value !== 0 && value !== 0n;
}
