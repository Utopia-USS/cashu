import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "./MarkdownDocument.js";
import { StrategiesView } from "./StrategiesView.js";
import { readyState } from "./testing/storyState.js";

describe("Strategies read-only presentation", () => {
  it.each(["en", "pl"] as const)(
    "shows the strategy prose and titles in incognito (%s)",
    (language) => {
      setLanguageForTests(language);
      const markup = renderToStaticMarkup(
        <UiEnvProvider locale="en-US" privacy={true}>
          <StrategiesView state={readyState} />
        </UiEnvProvider>,
      );
      expect(markup).toContain("Private synthetic investment prose.");
      expect(markup).toContain("Synthetic strategy");
    },
  );
  it("renders safe Markdown as elements and keeps forbidden links and HTML as text", () => {
    const markup = renderToStaticMarkup(
      <MarkdownDocument
        text={
          "<script>alert(1)</script>\n\n[unsafe](javascript:alert) [safe](https://example.test)\n\n```html\n<img src=x>\n```"
        }
      />,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain('href="https://example.test"');
    expect(markup).toContain('rel="noreferrer noopener"');
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;img src=x&gt;");
  });
});
