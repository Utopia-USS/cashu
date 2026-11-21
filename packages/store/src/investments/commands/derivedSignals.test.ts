import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { profileOf } from "../../core/queries.js";
import { stageDerivedSignals } from "./derivedSignals.js";
import { vault } from "./testing/fixtures.js";

describe("restricted derived signal staging", () => {
  it("rejects inherited deferred emits without leaking an effect when derived work refuses", () => {
    const v = vault();
    const resolve = vi.fn(() => ({ name: "Leaked derived rename" }));
    const command = defineCommand({
      id: "test.derivedDeferredRefusal",
      input: z.object({}),
      run(ctx) {
        ctx.emit("profile.created", ctx.vault, {
          slug: "synthetic",
          name: "Base owner write",
          baseCurrency: "PLN",
          mcpPrivacy: "strict",
        });
        const derived = stageDerivedSignals(ctx, (child) => {
          child.emitDeferred("profile.renamed", ctx.vault, resolve);
          return refuse("derived_refused");
        });
        return ok({ staged: derived.ok });
      },
    });
    const out = v.run(command, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.staged).toBe(false);
    expect(out.events.map((event) => event.type)).toEqual(["profile.created"]);
    expect(resolve).not.toHaveBeenCalled();
    expect(profileOf(v.store.read.bind(v.store))?.name).toBe("Base owner write");
  });
});
