// Web render tests (jsdom + Testing Library): every story of every chart renders through the DOM renderer,
// and the roles, names, privacy masking, tabular figures and keyboard tooltip behave as on the legacy SPA.
import { setLanguageForTests } from "@cashu/i18n";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as envStories from "../environment/UiEnvProvider.stories.js";
import * as areaStories from "./AreaChart.stories.js";
import * as barStories from "./BarChart.stories.js";
import * as donutStories from "./Donut.stories.js";
import { LineChart } from "./LineChart.js";
import * as lineStories from "./LineChart.stories.js";
import * as sparkStories from "./Sparkline.stories.js";
import { storyCases } from "./testing/csf.js";

beforeEach(() => setLanguageForTests("en"));
afterEach(cleanup);

const MODULES = { lineStories, areaStories, barStories, donutStories, sparkStories, envStories };
const story = (mod: Record<string, unknown>, name: string) => {
  const found = storyCases(mod).find(([n]) => n === name);
  if (!found) throw new Error(`no story ${name}`);
  return found[1];
};

describe.each(Object.entries(MODULES))("%s", (_name, mod) => {
  it.each(storyCases(mod))("%s renders", (_story, element) => {
    const { container } = render(element);
    expect(container.firstElementChild).not.toBeNull();
  });
});

describe("LineChart (web)", () => {
  it("is one image named by its label and value summary, with tabular axis labels", () => {
    const { container } = render(story(lineStories, "Default"));
    const img = screen.getByRole("img");
    expect(img.getAttribute("aria-label")).toMatch(
      /^Net worth\. from 01\/25 to 12\/26\. Net worth: latest/,
    );
    const axis = [...container.querySelectorAll("text")];
    expect(axis.some((t) => /\d+k/.test(t.textContent ?? ""))).toBe(true);
    expect(axis.every((t) => t.classList.contains("tabular-nums"))).toBe(true);
    expect(container.querySelector("path.stroke-chart-1")).not.toBeNull();
  });

  it("hides the amount axis and speaks amounts as hidden in privacy mode", () => {
    const { container } = render(story(lineStories, "PrivacyMode"));
    const labels = [...container.querySelectorAll("text")].map((t) => t.textContent ?? "");
    expect(labels.some((t) => /\d+k/.test(t))).toBe(false);
    expect(container.querySelectorAll("line.stroke-chart-grid")).toHaveLength(5);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("latest hidden");
  });

  it("keeps a share axis in privacy mode", () => {
    const { container } = render(story(lineStories, "ShareInPrivacyMode"));
    const labels = [...container.querySelectorAll("text")].map((t) => t.textContent ?? "");
    expect(labels.some((t) => t.endsWith("%"))).toBe(true);
  });

  it("is a focusable group with a live tooltip stepped by the arrow keys", () => {
    render(story(lineStories, "Interactive"));
    const group = screen.getByRole("group", { name: "Net worth (arrow keys: values)" });
    expect(group.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => group.focus());
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("11/26");
    expect(within(status).getByText("Portfolio")).toBeTruthy();
    fireEvent.keyDown(group, { key: "Home" });
    expect(screen.getByRole("status").textContent).toContain("01/25");
    fireEvent.keyDown(group, { key: "Escape" });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("masks amount values in the tooltip in privacy mode", () => {
    render(story(lineStories, "PrivacyMode"));
    const group = screen.getByRole("group");
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(screen.getByRole("status").textContent).toContain("•••");
    expect(screen.getByRole("status").textContent).not.toMatch(/\d+k/);
  });

  it("follows the pointer to the nearest index", () => {
    // jsdom has no PointerEvent; a MouseEvent carries the same clientX.
    globalThis.PointerEvent ??= MouseEvent as unknown as typeof PointerEvent;
    const { container } = render(story(lineStories, "Interactive"));
    const svg = container.querySelector("svg") as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 230 }) as DOMRect;
    fireEvent.pointerMove(svg, { clientX: 56 });
    expect(screen.getByRole("status").textContent).toContain("01/25");
  });

  it("draws nothing until the container has a width (measured charts)", () => {
    const { container } = render(<LineChart label="Worth" series={[{ values: [1, 2] }]} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("img", { name: "Worth" })).toBeTruthy();
  });
});

describe("BarChart, Donut, Sparkline, AreaChart (web)", () => {
  it("names a bar chart by every value", () => {
    render(story(barStories, "Monthly"));
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /^Contributions: 01 2,000, 02 500, 03 none, 04 2,500/,
    );
  });

  it("drops bar value labels in privacy mode", () => {
    const { container } = render(story(barStories, "PrivacyMode"));
    const labels = [...container.querySelectorAll("text")].map((t) => t.textContent ?? "");
    expect(labels).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("speaks donut shares and masks an amount centre in privacy mode", () => {
    render(story(donutStories, "CenterInPrivacyMode"));
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Allocation: Equities 54%, Bonds 25%, Cash 16%, Gold 5%",
    );
    expect(screen.getByText("•••")).toBeTruthy();
    expect(screen.queryByText("184k")).toBeNull();
  });

  it("hides an unlabelled sparkline from assistive technology", () => {
    const { container } = render(story(sparkStories, "Decorative"));
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    cleanup();
    render(story(sparkStories, "Rising"));
    expect(screen.getByRole("img", { name: "30 days" })).toBeTruthy();
  });

  it("fades a single area layer through a per-instance gradient", () => {
    const { container } = render(story(areaStories, "SingleLayer"));
    const gradient = container.querySelector("linearGradient");
    expect(gradient?.id).toMatch(/^g[\w-]+s$/);
    expect(container.querySelector(`path[fill="url(#${gradient?.id})"]`)).not.toBeNull();
  });
});
