/** Best-effort owner reload proxy registration using the existing instrument command and planner. */
import { performance } from "@cashu/domain/investments";
import { loadStrategy } from "@cashu/domain/investments/strategy";
import { z } from "zod";
import { defineCommand, ok } from "../../command.js";
import { createInstrument } from "../commands/instruments.js";
import { findProxy } from "../performance/inputs.js";
export const ensureReloadProxy = defineCommand({
  id: "investments.strategies.ensureReloadProxy",
  input: z.strictObject({ yamlText: z.string(), mdText: z.string().nullable() }),
  run(context, input) {
    const result = loadStrategy(input.yamlText, input.mdText);
    const proxy = (result.config ?? result.partial)?.benchmark?.proxy;
    if (!proxy || findProxy(context.read, proxy)) return ok(null);
    const planned = performance.referenceInstrument(proxy);
    if (!planned) return ok(null);
    return createInstrument.run(
      context,
      createInstrument.input.parse({
        name: planned.name,
        currency: planned.currency,
        assetClass: planned.assetClass,
        symbol: planned.symbol ?? "",
        mic: planned.mic ?? "",
        aliases: planned.aliases.map((a) => ({
          namespace: a.namespace,
          value: a.value,
          guessed: a.guessed,
        })),
      }),
    );
  },
});
