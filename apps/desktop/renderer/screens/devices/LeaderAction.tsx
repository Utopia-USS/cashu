import { Button, Spinner } from "@cashu/ui";
import { T } from "./Devices.strings.js";
import type { LeaderActionState } from "./useLeaderAction.js";

const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";

/** The owner action is rendered from a profile-scoped headless state. */
export function LeaderAction({ state }: { state: LeaderActionState }) {
  const {
    list,
    available,
    target,
    setTarget,
    force,
    setForce,
    preview,
    typed,
    setTyped,
    status,
    operationId,
    blocked,
    expired,
    review,
    commit,
    inspect,
    cancel,
  } = state;
  if (!list || !available) return null;
  return (
    <section id="leader-repin" className="grid gap-3" aria-label={T.repinTitle}>
      <h4>{T.repinTitle}</h4>
      <p>{T.repinHelp}</p>
      <label className="grid gap-1">
        <span>{T.repinTarget}</span>
        <select
          className={control}
          value={target}
          disabled={!!preview || status === "busy"}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">{T.repinTarget}</option>
          {list.devices
            .filter(
              (device) => device.trusted && !device.revoked && device.id !== list.leader.device,
            )
            .map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
        </select>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={force}
          disabled={!!preview || status === "busy"}
          onChange={(event) => setForce(event.target.checked)}
        />
        {T.repinForce}
      </label>
      {force && <p role="alert">{T.repinOverlap}</p>}
      {!preview && (
        <Button
          disabled={!target || blocked || status === "busy" || status === "unknown"}
          onPress={review}
        >
          {T.repinReview}
        </Button>
      )}
      {preview && (
        <div className="grid gap-2 rounded-lg border border-border bg-surface-raised p-4">
          <p role="alert">{preview.force ? T.repinOverlap : T.repinHandover}</p>
          {preview.mayStillRun && <p role="alert">{T.repinMayStillRun}</p>}
          <label className="grid gap-1">
            <span>{T.repinType(preview.confirmationText)}</span>
            <input
              className={control}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button disabled={typed !== preview.confirmationText || expired} onPress={commit}>
              {T.repinCommit}
            </Button>
            <Button onPress={cancel}>{T.cancel}</Button>
          </div>
        </div>
      )}
      {status === "busy" && (
        <p role="status" className="flex items-center gap-1.5">
          <Spinner />
          {T.working}
        </p>
      )}
      {status === "completed" && <p role="status">{T.repinCompleted}</p>}
      {status === "failed" && <p role="alert">{T.failed}</p>}
      {status === "unknown" && <p role="alert">{T.unknown}</p>}
      {status === "unknown" && operationId && <Button onPress={inspect}>{T.inspect}</Button>}
    </section>
  );
}
