import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  csvMappingFromYaml,
  GenericCsvImporter,
  MAX_FILE_BYTES,
  reportOk,
  reportSummary,
  validateImportFile,
} from "@cashu/domain/investments/importing";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { UNHANDLED } from "./inspection.js";

interface ValidateInput {
  readonly file: string;
  readonly mapping?: string;
}

function parse(args: readonly string[]): ValidateInput | null {
  let file: string | undefined;
  let mapping: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mapping") {
      if (mapping !== undefined || !args[i + 1]) return null;
      mapping = args[++i];
    } else if (arg?.startsWith("--mapping=")) {
      if (mapping !== undefined) return null;
      mapping = arg.slice("--mapping=".length);
      if (!mapping) return null;
    } else if (arg && !arg.startsWith("-") && file === undefined) file = arg;
    else return null;
  }
  return file === undefined ? null : { file, ...(mapping === undefined ? {} : { mapping }) };
}

async function bounded(path: string, cwd: string, max: number): Promise<Uint8Array | null> {
  const full = resolve(cwd, path);
  const info = await stat(full);
  if (!info.isFile() || info.size > max) return null;
  const handle = await open(full, "r");
  try {
    const buffer = Buffer.allocUnsafe(info.size);
    let used = 0;
    while (used < buffer.length) {
      const result = await handle.read(buffer, used, buffer.length - used, used);
      if (result.bytesRead === 0) return null;
      used += result.bytesRead;
    }
    if ((await handle.stat()).size !== info.size) return null;
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Standalone file inspection: no vault or database; unsupported I/O exits before output. */
export async function validateFile(
  args: readonly string[],
  io: CommandIo,
): Promise<number | typeof UNHANDLED> {
  const input = parse(args);
  if (!input || io.signal.aborted) return UNHANDLED;
  // Source's generic importer is CSV only; XLSX requires a separately authorized decoder.
  if (input.file.toLowerCase().endsWith(".xlsx")) return UNHANDLED;
  let file: Uint8Array | null;
  let mapping: string | null = null;
  try {
    file = await bounded(input.file, io.cwd, MAX_FILE_BYTES);
    if (file === null) return UNHANDLED;
    if (input.mapping !== undefined) {
      const raw = await bounded(input.mapping, io.cwd, 1_048_576);
      if (raw === null) return UNHANDLED;
      mapping = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    }
  } catch {
    return UNHANDLED;
  }
  if (io.signal.aborted) return 130;
  let importer: GenericCsvImporter | undefined;
  if (mapping !== null) {
    const parsed = csvMappingFromYaml(mapping);
    if (!parsed.ok) {
      for (const issue of parsed.issues)
        printConsole(io, `mapping ${issue.path}: ${issue.message}`, { highlight: false });
      return 1;
    }
    importer = new GenericCsvImporter(parsed.mapping);
  }
  const report = validateImportFile({ name: basename(input.file), content: file }, importer);
  printConsole(io, reportSummary(report), { highlight: false });
  return reportOk(report) ? 0 : 1;
}
