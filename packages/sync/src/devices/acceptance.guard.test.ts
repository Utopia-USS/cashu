// Guard (S29c review H5'): every signature check in devices/ goes through acceptance.ts, whose key
// sources are decision keys (decisionKeys.ts), the recovery root, the certificate being admitted, or
// the scanned invite. This test fails when any other file here calls a raw verifier: a new
// acceptance site cannot bypass the rule silently.
//
// Forbidden outside acceptance.ts (the gate) and statements.ts (the raw verifiers themselves):
// - calling `verify`, `verifyStatement`, `verifyContextSignature`, `verifySignature`,
//   `verifyWrapSignature` or `unwrapKeys` directly, or through `.call` / `.apply` / `.bind`;
// - calling an injected verifier as a member or private field (`ctx.verify(...)`, `this.#verify(...)`);
// - aliasing a raw verifier under a name that does not say "verif" (`const check = verifyStatement`);
//   injecting it as `verify` (a default parameter, a field) is allowed: calling those is caught above.
// Allowed: passing a verifier to the gate (`accepted(verify, ...)`) and `CertificateIndex.verify`
// (trust resolution over certificates, not a signature check on a statement).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAW =
  "verify|verifyStatement|verifyContextSignature|verifySignature|verifyWrapSignature|unwrapKeys";
const RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "direct call", pattern: new RegExp(`(^|[^\\w.#$])(${RAW})\\s*\\(`, "m") },
  {
    name: "call / apply / bind",
    pattern: new RegExp(`\\b(${RAW})\\s*\\.\\s*(call|apply|bind)\\b`),
  },
  { name: "private field call", pattern: /#\w*verif\w*\s*\(/i },
  { name: "member call", pattern: /(?<!index)\.\s*verif\w*\s*\(/i },
  // An assignment of a raw verifier to a name that does not say "verif" could be called unseen.
  {
    name: "alias",
    pattern: new RegExp(`\\b(?!\\w*verif)\\w+\\s*(:[^=,()]*)?=\\s*(${RAW})\\s*[;,)]`, "i"),
  },
];

const GATE = new Set(["acceptance.ts", "statements.ts"]);

/** Drops comments (line and block) so documentation never trips the guard. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function violations(source: string): string[] {
  const text = code(source);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const rule of RULES) if (rule.pattern.test(line)) out.push(`${rule.name}: ${line.trim()}`);
  }
  return out;
}

const DIR = import.meta.dirname;

describe("guard: signatures in devices/ are checked only through acceptance.ts", () => {
  it("no production file here calls a raw verifier", () => {
    const files = readdirSync(DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !GATE.has(f),
    );
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((f) =>
      violations(readFileSync(join(DIR, f), "utf8")).map((v) => `${f}: ${v}`),
    );
    expect(found).toEqual([]);
  });

  it("the guard catches planted violations (and lets the gate's own use through)", () => {
    const planted = [
      'const ok = verifyStatement("cashu/lease/v1", body, sig, key);',
      'if (keys.some((k) => verify("cashu/registry/v1", body, sig, k))) return;',
      "return verifyWrapSignature(wire, vaultId, recipient, signer, key);",
      "const out = unwrapKeys(sodium, wire, me, ring, signer, policy);",
      'const ok = this.#verify("cashu/lease/v1", body, sig, key);',
      'const ok = ctx.verify("cashu/lease/v1", body, sig, key);',
      "const check = verifyStatement;",
      "return verifyStatement.call(undefined, context, body, sig, key);",
    ];
    for (const line of planted) expect(violations(line), line).not.toEqual([]);
    const allowed = [
      'accepted(verify, "cashu/lease/v1", body, sig, { kind: "recovery", signKeys });',
      "const trust = index.verify(revokedIds);",
      "this.#trusted ??= this.#index.verify(this.#revoked).devices;",
      "// a comment may mention verifyStatement(context, body) freely",
      "export function verifyAll(): void {}",
    ];
    for (const line of allowed) expect(violations(line), line).toEqual([]);
  });
});
