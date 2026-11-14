import { parseDateTime, toStorage } from "@cashu/domain";
import { expect, it } from "vitest";
import { runCommand, storeWriter } from "../../command.js";
import { createThesis, updateThesis } from "../commands/journal.js";
import { stock, vault } from "../commands/testing/fixtures.js";
import { thesisByGid } from "../queries/journal.js";
import { captureThesisEffect } from "./thesis-effects.js";

it("prospective create, selected update and review match actual folds with a genuinely advancing clock", () => {
  const v = vault();
  try {
    const instrument = stock(v, "SYN", "PL0000000SYN");
    let ticks = 0;
    const env = {
      ...v.env,
      clock: { now: () => Date.UTC(2026, 9, 31, 12, 0, 0) + ++ticks * 1000 },
    };
    let selected: string | undefined;
    for (const mode of ["create", "update", "review"] as const) {
      let projected: ReturnType<ReturnType<typeof captureThesisEffect>["row"]>;
      const before =
        selected === undefined ? undefined : thesisByGid(v.store.read.bind(v.store), selected);
      const command = {
        id: "test.thesisEffect",
        input: createThesis.input,
        run(
          ctx: Parameters<typeof createThesis.run>[0],
          input: Parameters<typeof createThesis.run>[1],
        ) {
          const effect = captureThesisEffect(ctx, before);
          const out =
            before === undefined
              ? createThesis.run(effect.context, input)
              : updateThesis.run(effect.context, {
                  id: before.gid,
                  values: mode === "update" ? { thesis: "Changed" } : {},
                  reviewed: mode === "review",
                });
          projected = effect.row();
          return out;
        },
      };
      const out = runCommand(
        v.store,
        storeWriter(v.store),
        command,
        { instrument, entryType: "trend", thesis: "Synthetic", exitPlan: "Synthetic exit" },
        env,
      );
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error(out.reason);
      selected = out.value.thesis;
      expect(projected).toEqual(thesisByGid(v.store.read.bind(v.store), selected));
      expect(toStorage(parseDateTime(out.events[0]?.at ?? ""))).not.toBe(projected?.updatedAt);
      if (mode === "review") {
        expect(projected?.reviewedAt).toBe(projected?.updatedAt);
        expect(projected?.coreChangedAt).toBe(before?.coreChangedAt);
        expect(projected?.exitPlanChangedAt).toBe(before?.exitPlanChangedAt);
      }
    }
    expect(ticks).toBeGreaterThan(9);
  } finally {
    v.store.close();
  }
});
