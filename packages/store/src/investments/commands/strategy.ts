// Strategy versions (Python `service/strategy.py` `load(record=True)`, the write side): the files'
// text is validated with the domain loader and stored as a new version when it differs from the
// current one (events.md 8.8; the fold also drops a version whose sha equals the current one at its
// position in the order, m9). Reading the files is the service's (`services/strategy.ts`).
import {
  issueRecord,
  loadStrategy,
  MAX_STRATEGY_CHARS,
  strategyDigest,
} from "@cashu/domain/investments/strategy";
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { latestStrategyVersion } from "../queries/strategy.js";

/**
 * Python `read_files`: a strategy file larger than this many bytes is not read (a read error, nothing
 * is stored). The loader itself reports a yaml over `MAX_STRATEGY_CHARS` characters as invalid.
 */
export const MAX_STRATEGY_FILE_BYTES = MAX_STRATEGY_CHARS * 4;

/** UTF-8 length of `text` without allocating (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export interface SavedStrategyVersion {
  /** A new version was emitted (false: the text equals the current version's). */
  readonly recorded: boolean;
  /** The new version's gid, or the current version's when nothing was recorded. */
  readonly version: string;
  readonly state: "valid" | "partial" | "invalid";
  readonly sha256: string;
}

export const saveStrategyVersion = defineCommand({
  id: "investments.saveStrategyVersion",
  input: z.object({
    yamlText: z.string(),
    mdText: z.string().nullable().default(null),
  }),
  /**
   * Python `load(record=True)` on files already read: state valid / partial / invalid from the
   * loader, sha256 = `_digest(yaml, md)`, issues as `issue_dict`. Emits `strategy.versionSaved` only
   * when the sha differs from the current version's.
   */
  run(ctx, input) {
    if (
      utf8Bytes(input.yamlText) > MAX_STRATEGY_FILE_BYTES ||
      (input.mdText !== null && utf8Bytes(input.mdText) > MAX_STRATEGY_FILE_BYTES)
    ) {
      return refuse("strategy_too_large");
    }
    const latest = latestStrategyVersion(ctx.read);
    const result = loadStrategy(input.yamlText, input.mdText);
    const state =
      result.config !== null ? "valid" : result.partial !== null ? "partial" : "invalid";
    const sha256 = strategyDigest(input.yamlText, input.mdText);
    if (latest?.sha256 === sha256) {
      return ok<SavedStrategyVersion>({ recorded: false, version: latest.gid, state, sha256 });
    }
    const version = ctx.newGid();
    ctx.emit("strategy.versionSaved", version, {
      yamlText: input.yamlText,
      mdText: input.mdText,
      sha256,
      state,
      issues: result.issues.map(issueRecord),
    });
    return ok<SavedStrategyVersion>({ recorded: true, version, state, sha256 });
  },
});
