import { Button } from "@cashu/ui";
import { B } from "./Banking.strings.js";
import type { useBankingScreen } from "./useBankingScreen.js";

const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";

export interface BankingScreenState {
  readonly screen: ReturnType<typeof useBankingScreen>;
  readonly available: boolean;
  readonly appId: string;
  readonly setAppId: (value: string) => void;
  readonly aspsp: string;
  readonly setAspsp: (value: string) => void;
  readonly callbackUrl: string;
  readonly setCallbackUrl: (value: string) => void;
  /** A file is being dragged over the key drop zone. */
  readonly dragging: boolean;
  readonly setDragging: (value: boolean) => void;
  /** What the owner typed to find their bank. */
  readonly bankQuery: string;
  readonly setBankQuery: (value: string) => void;
  /** Enable Banking's bank names that match `bankQuery`. */
  readonly matches: readonly string[];
  /** The listed bank "Połącz bank" will use; empty until one is picked or only one matches. */
  readonly chosen: string;
}

/** Pure profile-local view. The native bridge and state live in BankingScreen. */
export function BankingView({
  state,
  language,
}: {
  readonly state: BankingScreenState;
  readonly language: "pl" | "en";
}) {
  const { screen, appId, setAppId, setAspsp, callbackUrl, setCallbackUrl } = state;
  const { dragging, setDragging, bankQuery, setBankQuery, matches, chosen } = state;
  const t = (key: keyof typeof B) => B[key][language];
  if (!state.available) return <p role="status">{t("unavailable")}</p>;
  return (
    <section aria-label={t("title")} className="grid max-w-xl gap-3 text-md">
      <h3 className="font-strong text-fg">{t("title")}</h3>
      <p className="text-sm text-fg-muted">{t("keyHint")}</p>
      {!screen.configured && (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void screen.configure(appId);
          }}
        >
          <label className="grid gap-1">
            {t("appId")}
            <input
              className={control}
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              autoComplete="off"
              aria-describedby="banking-app-id-hint"
              maxLength={128}
            />
          </label>
          <p id="banking-app-id-hint" className="text-sm text-fg-muted">
            {t("appIdHint")}
          </p>
          {/* Mouse path only; the chooser button below is the keyboard path. */}
          <fieldset
            data-testid="banking-key-drop"
            aria-label={t("dropKey")}
            className={`grid justify-items-center gap-2 rounded-sm border border-dashed p-5 text-center ${dragging ? "border-accent bg-surface-raised" : "border-border"}`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              if (!dragging) setDragging(true);
            }}
            onDragLeave={(event) => {
              // Moving onto a child (the text, the button) is still inside the zone.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file && !screen.busy) void screen.configureDropped(appId, file);
            }}
          >
            <p>{t("dropKey")}</p>
            <p className="text-sm text-fg-muted">{t("dropOr")}</p>
            <Button type="submit" disabled={screen.busy}>
              {t("chooseKey")}
            </Button>
          </fieldset>
        </form>
      )}
      {screen.configured && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={screen.busy} onPress={() => void screen.check()}>
              {t("check")}
            </Button>
          </div>
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen) void screen.begin(chosen);
            }}
          >
            <label className="grid gap-1">
              {t("bankSearch")}
              <input
                className={control}
                type="search"
                value={bankQuery}
                onChange={(event) => setBankQuery(event.target.value)}
                maxLength={100}
                autoComplete="off"
              />
            </label>
            {screen.bankList === "loading" && (
              <p role="status" className="text-sm text-fg-muted">
                {t("banksLoading")}
              </p>
            )}
            {screen.bankList === "failed" && (
              <div className="grid justify-items-start gap-2">
                <p className="text-sm">{t("banksFailed")}</p>
                <Button
                  type="button"
                  disabled={screen.busy}
                  onPress={() => void screen.loadBanks()}
                >
                  {t("banksRetry")}
                </Button>
              </div>
            )}
            {screen.bankList === "ready" &&
              (matches.length > 0 ? (
                <label className="grid gap-1">
                  {t("bank")}
                  <select
                    className={control}
                    size={Math.min(6, Math.max(2, matches.length))}
                    value={chosen}
                    onChange={(event) => setAspsp(event.target.value)}
                  >
                    {matches.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="text-sm">{t("noBankMatch")}</p>
              ))}
            <Button type="submit" disabled={screen.busy || !chosen}>
              {t("consent")}
            </Button>
            {!chosen && screen.bankList === "ready" && matches.length > 0 && (
              <p className="text-sm text-fg-muted">{t("pickBank")}</p>
            )}
          </form>
          {screen.pendingUrl && (
            <div className="grid gap-2" role="status">
              <p>{t("waiting")}</p>
              <Button type="button" onPress={() => void screen.open()}>
                {t("openBank")}
              </Button>
              <Button type="button" disabled={screen.busy} onPress={() => void screen.cancel()}>
                {t("cancel")}
              </Button>
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const submitted = callbackUrl;
                  setCallbackUrl("");
                  void screen.complete(submitted);
                }}
              >
                <label className="grid gap-1">
                  {t("manual")}
                  <input
                    className={control}
                    type="url"
                    value={callbackUrl}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                    maxLength={4096}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <Button type="submit" disabled={screen.busy}>
                  {t("complete")}
                </Button>
              </form>
            </div>
          )}
          <div className="grid gap-2">
            <h4 className="font-strong text-fg">{t("sessions")}</h4>
            {screen.connected.map((session) => (
              <div key={session.handle} className="rounded-md border border-border p-3">
                <p>{session.institution}</p>
                <p className="text-sm">{t("localForget")}</p>
                <Button
                  type="button"
                  disabled={screen.busy}
                  onPress={() => void screen.forget(session.handle)}
                >
                  {t("forget")}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              disabled={screen.busy || screen.connected.length === 0}
              onPress={() => void screen.sync()}
            >
              {t("sync")}
            </Button>
          </div>
        </>
      )}
      {screen.attemptList.map((attempt) => (
        <div key={attempt.key} role="status" className="grid gap-2">
          <p>
            {t(
              attempt.status === "outcome_unknown"
                ? "attemptUnknown"
                : attempt.status === "not_started"
                  ? "notStarted"
                  : attempt.status,
            )}
          </p>
          {attempt.status === "outcome_unknown" && (
            <Button
              type="button"
              disabled={screen.busy}
              onPress={() => void screen.checkAttempt(attempt.key)}
            >
              {t("checkAttempt")}
            </Button>
          )}
        </div>
      ))}
      {screen.busy && <p role="status">{t("busy")}</p>}
      {screen.notice && (
        <p role="status">
          {screen.notice === "checked" && screen.application
            ? `${t("checked")} ${t("checkedApp")} ${screen.application}`
            : t(screen.notice)}
        </p>
      )}
    </section>
  );
}
