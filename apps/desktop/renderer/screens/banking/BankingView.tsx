import { B } from "./Banking.strings.js";
import type { useBankingScreen } from "./useBankingScreen.js";

const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";

export interface BankingScreenState {
  readonly screen: ReturnType<typeof useBankingScreen>;
  readonly available: boolean;
  readonly appId: string;
  readonly setAppId: (value: string) => void;
  readonly aspsp: string;
  readonly setAspsp: (value: string) => void;
  readonly callbackUrl: string;
  readonly setCallbackUrl: (value: string) => void;
}

/** Pure profile-local view. The native bridge and state live in BankingScreen. */
export function BankingView({
  state,
  language,
}: {
  readonly state: BankingScreenState;
  readonly language: "pl" | "en";
}) {
  const { screen, appId, setAppId, aspsp, setAspsp, callbackUrl, setCallbackUrl } = state;
  const t = (key: keyof typeof B) => B[key][language];
  if (!state.available) return <p role="status">{t("unavailable")}</p>;
  return (
    <section aria-label={t("title")} className="grid max-w-xl gap-5">
      <h2 className="text-headline font-semibold">{t("title")}</h2>
      <p>{t("keyHint")}</p>
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
              required
              maxLength={128}
            />
          </label>
          <button className={button} type="submit" disabled={screen.busy}>
            {t("chooseKey")}
          </button>
        </form>
      )}
      {screen.configured && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              type="button"
              disabled={screen.busy}
              onClick={() => void screen.check()}
            >
              {t("check")}
            </button>
            <button
              className={button}
              type="button"
              disabled={screen.busy}
              onClick={() => void screen.loadBanks()}
            >
              {t("banks")}
            </button>
          </div>
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void screen.begin(aspsp);
            }}
          >
            <label className="grid gap-1">
              {t("bank")}
              <input
                className={control}
                list="banking-institutions"
                value={aspsp}
                onChange={(event) => setAspsp(event.target.value)}
                required
                maxLength={256}
                autoComplete="off"
              />
            </label>
            <datalist id="banking-institutions">
              {screen.institutions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <button className={button} type="submit" disabled={screen.busy}>
              {t("consent")}
            </button>
          </form>
          {screen.pendingUrl && (
            <div className="grid gap-2" role="status">
              <p>{t("waiting")}</p>
              <button className={button} type="button" onClick={() => void screen.open()}>
                {t("openBank")}
              </button>
              <button
                className={button}
                type="button"
                disabled={screen.busy}
                onClick={() => void screen.cancel()}
              >
                {t("cancel")}
              </button>
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
                <button className={button} type="submit" disabled={screen.busy}>
                  {t("complete")}
                </button>
              </form>
            </div>
          )}
          <div className="grid gap-2">
            <h3 className="font-semibold">{t("sessions")}</h3>
            {screen.connected.map((session) => (
              <div key={session.handle} className="rounded-md border border-border p-3">
                <p>{session.institution}</p>
                <p className="text-sm">{t("localForget")}</p>
                <button
                  className={button}
                  type="button"
                  disabled={screen.busy}
                  onClick={() => void screen.forget(session.handle)}
                >
                  {t("forget")}
                </button>
              </div>
            ))}
            <button
              className={button}
              type="button"
              disabled={screen.busy || screen.connected.length === 0}
              onClick={() => void screen.sync()}
            >
              {t("sync")}
            </button>
          </div>
        </>
      )}
      {screen.attemptList.map((attempt) => (
        <div key={attempt.key} role="status" className="grid gap-2">
          <p>
            {t(
              attempt.status === "outcome_unknown"
                ? "unknown"
                : attempt.status === "not_started"
                  ? "notStarted"
                  : attempt.status,
            )}
          </p>
          {attempt.status === "outcome_unknown" && (
            <button
              className={button}
              type="button"
              disabled={screen.busy}
              onClick={() => void screen.checkAttempt(attempt.key)}
            >
              {t("checkAttempt")}
            </button>
          )}
        </div>
      ))}
      {screen.busy && <p role="status">{t("busy")}</p>}
      {screen.notice && (
        <p role="status">
          {t(
            screen.notice === "unknown"
              ? "unknown"
              : screen.notice === "refreshed"
                ? "refreshed"
                : "error",
          )}
        </p>
      )}
    </section>
  );
}
