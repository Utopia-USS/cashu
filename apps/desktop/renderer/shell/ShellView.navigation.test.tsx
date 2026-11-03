import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { S } from "../Desktop.strings.js";
import shell from "./ShellView.stories.js";

test("native Investments tab remains available without legacy access", () => {
  const markup = renderToStaticMarkup(
    <shell.component
      {...shell.args}
      state={{ ...shell.args.state, enabledModules: ["investments"], canOpenLegacy: false }}
    />,
  );
  const investmentsButton = markup.match(new RegExp(`<button[^>]*>${S.investments}</button>`))?.[0];
  expect(investmentsButton).toBeDefined();
  expect(investmentsButton).not.toContain("disabled");
  expect(investmentsButton).not.toContain(S.legacyUnavailable);
});
