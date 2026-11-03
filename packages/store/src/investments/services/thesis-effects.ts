/** The existing prospective thesis effect, with actual legal domain stamps for advancing clocks. */
import { parseDateTime, toStorage } from "@cashu/domain";
import type { CommandContext } from "../../command.js";
import type { ThesisView } from "../queries/journal.js";

export function captureThesisEffect(ctx: CommandContext, before?: ThesisView) {
  let prospective: ThesisView | undefined;
  const domainTime = ctx.now();
  const at = toStorage(parseDateTime(domainTime));
  const context: CommandContext = {
    ...ctx,
    emit(type, target, data, options) {
      const stamps = {
        updated_at: domainTime,
        core_changed_at: domainTime,
        exit_plan_changed_at: domainTime,
        reviewed_at: domainTime,
      };
      if (type === "thesis.created") {
        prospective = {
          gid: target,
          instrument: String(data.instrument),
          entryType: String(data.entryType),
          thesis: String(data.thesis),
          invalidation: typeof data.invalidation === "string" ? data.invalidation : null,
          exitPlan: typeof data.exitPlan === "string" ? data.exitPlan : null,
          sizePlan: typeof data.sizePlan === "string" ? data.sizePlan : null,
          reviewedAt: null,
          createdAt: at,
          updatedAt: at,
          coreChangedAt: at,
          exitPlanChangedAt: data.exitPlan ? at : null,
        };
        return ctx.emit(
          type,
          target,
          { ...data, stamps: { ...stamps, created_at: domainTime, reviewed_at: null } },
          options,
        );
      }
      if (type !== "thesis.updated" || before === undefined || target !== before.gid)
        throw new Error("unexpected thesis effect");
      const fields = ["entryType", "thesis", "invalidation", "exitPlan", "sizePlan"] as const;
      const values = Object.fromEntries(
        fields.filter((key) => key in data).map((key) => [key, data[key]]),
      );
      const coreChanged = ["entryType", "thesis", "invalidation"].some(
        (key) => key in data && data[key] !== before[key as keyof ThesisView],
      );
      const exitChanged = "exitPlan" in data && data.exitPlan !== before.exitPlan;
      prospective = {
        ...before,
        ...values,
        updatedAt: at,
        reviewedAt: data.reviewed === true ? at : before.reviewedAt,
        coreChangedAt: coreChanged ? at : before.coreChangedAt,
        exitPlanChangedAt: exitChanged ? (data.exitPlan ? at : null) : before.exitPlanChangedAt,
      };
      return ctx.emit(type, target, { ...data, stamps }, options);
    },
  };
  return { context, row: () => prospective };
}
