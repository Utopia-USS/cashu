import { Button } from "@cashu/ui";
import { T } from "./Classification.strings.js";
import type { useClassificationScreen } from "./useClassificationScreen.js";

type State = ReturnType<typeof useClassificationScreen>;

export function ClassificationView({ state }: { state: State }) {
  return (
    <section className="grid gap-3" aria-label={T.title}>
      <p>{T.localDetail}</p>
      {state.notice && <p role="status">{state.notice}</p>}
      {state.snapshot && (
        <>
          <p role="status">{state.snapshot.backend === "anthropic" ? T.cloud : T.local}</p>
          <label className="grid gap-1">
            {T.key}
            <input
              type="password"
              autoComplete="off"
              value={state.key}
              onChange={(event) => state.setKey(event.target.value)}
            />
          </label>
          <p>{state.snapshot.keyPresent ? T.keyStored : T.keyMissing}</p>
          <p>{T.keyChange}</p>
          <div className="flex gap-2">
            <Button type="button" disabled={state.busy || !state.key} onPress={state.saveKey}>
              {T.saveKey}
            </Button>
            <Button
              type="button"
              disabled={state.busy || !state.snapshot.keyPresent}
              onPress={state.clearKey}
            >
              {T.clearKey}
            </Button>
          </div>
          <p>{T.risk}</p>
          {state.snapshot.backend === "anthropic" ? (
            <Button type="button" disabled={state.busy} onPress={state.revokeCloud}>
              {T.revoke}
            </Button>
          ) : (
            <>
              <label className="grid gap-1">
                {T.model}
                <input
                  value={state.model}
                  onChange={(event) => state.setModel(event.target.value)}
                />
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={state.accepted}
                  onChange={(event) => state.setAccepted(event.target.checked)}
                />
                {T.consent}
              </label>
              <Button
                type="button"
                disabled={state.busy || !state.accepted || !state.snapshot.keyPresent}
                onPress={state.grantCloud}
              >
                {T.enable}
              </Button>
            </>
          )}
        </>
      )}
    </section>
  );
}
