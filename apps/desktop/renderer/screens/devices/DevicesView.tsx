import { T } from "./Devices.strings.js";
import type { DevicesScreenState } from "./useDevicesScreen.js";

const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";

export function DevicesView({ state }: { state: DevicesScreenState }) {
  if (state.list?.kind !== "ready") return <p>{T.unavailable}</p>;
  const list = state.list;
  const reviewBlocked =
    list.evidence.historyPending ||
    list.evidence.overflow ||
    list.evidence.authorityUncertain ||
    list.evidence.writeAdmission !== "ready" ||
    list.operations.some((operation) => operation.phase === "may_append");
  return (
    <div className="grid gap-4">
      {list.evidence.overflow ? (
        <p role="alert">{T.evidenceOverflow}</p>
      ) : list.evidence.historyPending || list.evidence.authorityUncertain ? (
        <p role="alert">{T.evidencePending}</p>
      ) : list.evidence.writeAdmission !== "ready" ? (
        <p role="alert">{T.writerPaused}</p>
      ) : null}
      {list.devices
        .filter((device) => device.forked)
        .map((device) => (
          <p role="alert" key={device.id}>
            {device.name}: {T.forked}
          </p>
        ))}
      {list.devices
        .filter((device) => device.behind && !device.forked)
        .map((device) => (
          <p role="status" key={device.id}>
            {device.name}: {T.behind}
          </p>
        ))}
      <label className="grid gap-2">
        <span>{T.choose}</span>
        <select
          className={control}
          value={state.target}
          onChange={(event) => state.setTarget(event.target.value)}
          disabled={!!state.preview || state.status === "busy"}
        >
          <option value="">{T.choose}</option>
          {list.devices
            .filter((device) => device.id !== list.ownDevice && device.trusted && !device.revoked)
            .map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
        </select>
      </label>
      {!state.preview && (
        <button
          className={button}
          type="button"
          disabled={!state.target || state.status === "busy" || reviewBlocked}
          onClick={() => void state.review()}
        >
          {T.preview}
        </button>
      )}
      {state.preview && (
        <div className="grid gap-4 rounded-lg border border-border bg-surface-raised p-4">
          <p role="alert">{T.warning}</p>
          <ul>
            {state.preview.targets.map((target) => (
              <li key={target.device}>
                {list.devices.find((device) => device.id === target.device)?.name ?? target.device}:{" "}
                {target.head === "trusted" ? T.headTrusted : T.headLocalStart}
              </li>
            ))}
          </ul>
          {state.preview.affected.length > 0 && (
            <fieldset className="grid gap-2">
              <legend>{T.orphanTitle}</legend>
              {state.preview.affected.map((device) => (
                <label key={device.device} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    disabled={state.status === "busy"}
                    checked={state.recertify.includes(device.device)}
                    onChange={(event) => state.toggleRecertify(device.device, event.target.checked)}
                  />
                  {T.orphanChoice}: {device.name}
                </label>
              ))}
            </fieldset>
          )}
          {state.selectionDirty && (
            <button
              className={button}
              type="button"
              disabled={state.status === "busy"}
              onClick={() => void state.review()}
            >
              {T.refreshSelection}
            </button>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              disabled={state.status === "busy"}
              checked={state.warningAck}
              onChange={(event) => state.setWarningAck(event.target.checked)}
            />
            {T.warningAck}
          </label>
          {state.preview.localStartConfirmationRequired && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                disabled={state.status === "busy"}
                checked={state.localAck}
                onChange={(event) => state.setLocalAck(event.target.checked)}
              />
              {T.localStart}
            </label>
          )}
          <label className="grid gap-2">
            <span>{T.recovery}</span>
            <span>{T.recoveryHelp}</span>
            <input
              className={control}
              disabled={state.status === "busy"}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={state.phrase}
              onChange={(event) => state.setPhrase(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              className={button}
              type="button"
              disabled={
                state.status === "busy" ||
                state.selectionDirty ||
                !state.warningAck ||
                !state.phrase ||
                (state.preview.localStartConfirmationRequired && !state.localAck)
              }
              onClick={() => void state.commit()}
            >
              {T.remove}
            </button>
            <button
              className={button}
              type="button"
              disabled={state.status === "busy"}
              onClick={() => void state.cancel()}
            >
              {T.cancel}
            </button>
          </div>
        </div>
      )}
      {state.status === "completed" && <p role="status">{T.completed}</p>}
      {state.status === "failed" && (
        <p role="alert">{state.refusal === "recertify_capacity" ? T.capacity : T.failed}</p>
      )}
      {state.status === "unknown" && <p role="alert">{T.unknown}</p>}
      {state.status === "unknown" && state.operationId && (
        <button className={button} type="button" onClick={() => void state.inspect()}>
          {T.inspect}
        </button>
      )}
    </div>
  );
}
