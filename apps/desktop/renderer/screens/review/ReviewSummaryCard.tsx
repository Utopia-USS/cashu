import { D } from "@cashu/domain";
import { Amount, Button } from "@cashu/ui";
import { R } from "./Review.strings.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

export function ReviewSummaryCard({ state }: { state: ReviewScreenState }) {
  return (
    <>
      <h3 className="text-title font-strong">
        {R.reviewedCards}: <Amount value={D(String(state.verdictRows.length))} fractionDigits={0} />
      </h3>
      {state.verdictRows.map((row) => (
        <p key={row.id}>
          {R[row.id]}: {row.verdict === "flag" ? R.flagged : R.kept}
        </p>
      ))}
      <p>
        {R.agenda}: <Amount value={D(String(state.agenda.length))} fractionDigits={0} /> ·{" "}
        {R.choices}: <Amount value={D(String(state.chosen.length))} fractionDigits={0} />
      </p>
      <h3 className="text-title font-strong">{R.agenda}</h3>
      {state.agenda.map((row) => (
        <p key={row.card}>
          {R[row.card]}: {row.note ?? R.flagged}
        </p>
      ))}
      <h3 className="text-title font-strong">{R.choices}</h3>
      {state.chosen.map((row) => (
        <p key={row.key}>
          {row.subject}: {row.label}
        </p>
      ))}
      <h3 className="text-title font-strong">{R.skipped}</h3>
      {state.skips.map((row) => (
        <p key={row.id}>
          {R[row.id]}: {row.label}
        </p>
      ))}
      <state.form.Field name="closing">
        {(field) => (
          <label className="grid gap-2">
            {R.closing}
            <textarea
              className="rounded-sm border border-border bg-surface p-3"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
          </label>
        )}
      </state.form.Field>
      <Button disabled={state.pending !== null} onPress={() => void state.save()}>
        {R.finish}
      </Button>
    </>
  );
}
