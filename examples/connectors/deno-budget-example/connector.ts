// Example cashU connector (kind file, module budget) in TypeScript on Deno: the made-up Bank Testowy
// CSV statement -> cashu-budget-import v1 JSON (docs/budget-import-format.md).
//
// Protocol (docs/connectors.md): one JSON request on stdin, one JSON response on stdout, logs on
// stderr. The app runs it with its own Deno: `run: [deno, connector.ts]`, no flags (the app sets every
// permission: read this directory and the run directory, write the run directory, nothing else).
// Imports: only files of this directory (./parse.ts) and node: built-ins; no npm:, jsr: or https:.

import { BadFile, confidence, convert } from "./parse.ts";

interface Request {
  api_version?: number;
  command?: string;
  file?: { path: string; name: string };
  account?: { currency?: string; label?: string };
}

function reply(payload: unknown, code = 0): never {
  console.log(JSON.stringify(payload));
  Deno.exit(code);
}

function fail(kind: string, message: string): never {
  reply({ error: { kind, message } }, 1);
}

let request: Request;
try {
  request = JSON.parse(await new Response(Deno.stdin.readable).text());
} catch {
  fail("internal", "the request is not JSON");
}
if (request.api_version !== 1) fail("unsupported_version", "api_version 1 only");

function readInput(): string {
  if (!request.file) fail("internal", "no input file in the request");
  try {
    return Deno.readTextFileSync(request.file.path);
  } catch {
    fail("bad_file", "the file cannot be read as UTF-8 text");
  }
}

try {
  if (request.command === "detect") {
    let text = "";
    try {
      text = readInput();
    } catch {
      // never fail on a foreign file
    }
    const score = confidence(text);
    reply({ match: score > 0, confidence: score });
  }
  if (request.command === "convert") {
    const document = convert(readInput(), request.account?.currency ?? "PLN");
    console.error(`converted ${document.transactions.length} rows`); // counts only, never values
    reply({ document });
  }
  fail("internal", "unknown command");
} catch (e) {
  if (e instanceof BadFile) fail("bad_file", e.message);
  throw e;
}
