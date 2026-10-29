// cashU file connector (module budget) on Deno: a Polish bank's CSV export -> cashu-budget-import v1.
//
// Protocol (docs/connectors.md): one JSON request on stdin, one JSON response on stdout, logs on
// stderr (counts only, never values). The bank-specific part is ./parse.ts; ./pycompat.ts holds the
// Python-compatible primitives. This file is identical in mbank-csv, erste-csv and pekao-csv.

import { detect, parse } from "./parse.ts";
import { BadFile, toDocument } from "./pycompat.ts";

interface Request {
  api_version?: number;
  command?: string;
  file?: { path: string; name: string };
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

function readInput(): Uint8Array {
  if (!request.file) fail("internal", "no input file in the request");
  try {
    return Deno.readFileSync(request.file.path);
  } catch {
    fail("bad_file", "the file cannot be read");
  }
}

if (request.command === "detect") {
  let confidence = 0;
  try {
    confidence = detect(Deno.readFileSync(request.file?.path ?? ""));
  } catch {
    confidence = 0; // never fail on a foreign file
  }
  reply({ match: confidence > 0, confidence });
}
if (request.command === "convert") {
  try {
    const statement = parse(readInput());
    if (!statement.transactions.length) fail("bad_file", "the file holds no transactions");
    console.error(`converted ${statement.transactions.length} rows`);
    reply({ document: toDocument(statement) });
  } catch (e) {
    if (e instanceof BadFile) fail("bad_file", e.message);
    fail("internal", "the conversion failed");
  }
}
fail("internal", "unknown command");
