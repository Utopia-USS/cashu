// Scene builders: what each chart draws for given props, size and privacy mode (platform free).
import { setLanguageForTests } from "@cashu/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { areaScene } from "./areaScene.js";
import { barScene } from "./barScene.js";
import { donutScene } from "./donutScene.js";
import { AREA_FADE, lineScene } from "./lineScene.js";
import type { SceneNode, TextNode } from "./scene.js";
import { sparkScene } from "./sparkScene.js";
import type { LineChartProps } from "./types.js";
import { MASK, maskTip } from "./values.js";

const texts = (nodes: SceneNode[]) =>
  nodes.filter((n): n is TextNode => n.k === "text").map((n) => n.text);

beforeEach(() => setLanguageForTests("en"));

const line: LineChartProps = {
  label: "Net worth",
  series: [{ values: [0, 50, 100], area: true, name: "Worth" }],
  yFormat: (v) => `${Math.round(v)} zl`,
  xLabels: [
    { i: 0, text: "Jan" },
    { i: 2, text: "Mar" },
  ],
};

describe("lineScene", () => {
  it("lays out like the legacy chart: padded extent, 5 grid lines with labels, x labels at the ends", () => {
    const { scene } = lineScene(line, 400, false);
    expect(scene.width).toBe(400);
    const grid = scene.nodes.filter((n) => n.k === "line" && n.stroke === "grid");
    expect(grid).toHaveLength(5);
    // extent [-6, 106] over y 208..10: the 0 tick of the legacy ticks() sits at the plot bottom
    expect(texts(scene.nodes)).toEqual([
      "-6 zl",
      "22 zl",
      "50 zl",
      "78 zl",
      "106 zl",
      "Jan",
      "Mar",
    ]);
    const anchors = scene.nodes.filter((n): n is TextNode => n.k === "text").slice(-2);
    expect(anchors.map((t) => t.anchor)).toEqual(["start", "end"]);
  });

  it("fills the area with a fade from the plot top to the plot bottom", () => {
    const { scene } = lineScene(line, 400, false);
    expect(scene.gradients).toEqual([
      { id: "a0", color: "series1", strong: AREA_FADE, y1: 10, y2: 208 },
    ]);
    expect(scene.nodes.some((n) => n.k === "path" && typeof n.fill === "object")).toBe(true);
  });

  it("hides the amount axis in privacy mode but keeps the grid; a share axis stays", () => {
    const hidden = lineScene(line, 400, true).scene.nodes;
    expect(texts(hidden)).toEqual(["Jan", "Mar"]);
    expect(hidden.filter((n) => n.k === "line" && n.stroke === "grid")).toHaveLength(5);
    const share = lineScene({ ...line, valueKind: "share" }, 400, true).scene.nodes;
    expect(texts(share)).toHaveLength(7);
  });

  it("summarises every series and the x range; privacy speaks amounts as hidden", () => {
    expect(lineScene(line, 400, false).summary).toBe(
      "Net worth. from Jan to Mar. Worth: latest 100 zl, low 0 zl, high 100 zl",
    );
    expect(lineScene(line, 400, true).summary).toBe(
      "Net worth. from Jan to Mar. Worth: latest hidden, low hidden, high hidden",
    );
    expect(lineScene({ ...line, series: [{ values: [] }] }, 400, false).summary).toBe(
      "Net worth: no data",
    );
  });

  it("draws the benchmark dashed and muted, stacks end and level labels 13 px apart", () => {
    const { scene } = lineScene(
      {
        ...line,
        series: [
          { values: [10, 20, 30], endLabel: "A" },
          { values: [10, 20, 29.9], tone: "bench", endLabel: "B" },
        ],
        levels: [{ y: 15, kind: "cost", label: "Cost" }],
      },
      400,
      false,
    );
    const bench = scene.nodes.find((n) => n.k === "path" && n.stroke === "muted");
    expect(bench).toMatchObject({ dash: "4 4", width: 2 });
    const cost = scene.nodes.find((n) => n.k === "line" && n.dash === "1 3");
    expect(cost).toBeDefined();
    const labels = scene.nodes.filter(
      (n): n is TextNode => n.k === "text" && /^[AB]$/.test(n.text),
    );
    expect(Math.abs((labels[1]?.y ?? 0) - (labels[0]?.y ?? 0))).toBeGreaterThanOrEqual(13);
  });

  it("is static without a tooltip; with one it scrubs over the plot and focuses every series", () => {
    expect(lineScene(line, 400, false).scrub).toBeNull();
    const { scrub } = lineScene({ ...line, tooltip: () => ({ title: "", rows: [] }) }, 400, false);
    expect(scrub).toMatchObject({ n: 3, x0: 56, x1: 336 });
    const focus = scrub?.focus(2);
    expect(focus?.x).toBe(336);
    expect(focus?.dots).toHaveLength(1);
    expect(focus?.tipY).toBe(focus?.dots[0]?.cy);
  });

  it("never draws narrower than 120 px", () => {
    expect(lineScene(line, 40, false).scene.width).toBe(120);
  });
});

describe("areaScene", () => {
  const layers = [
    { key: "a", name: "Cash", color: 1 as const, values: [10, 20] },
    { key: "l", name: "Loan", color: 7 as const, values: [-5, -4] },
  ];

  it("stacks solid layers and draws the total line; a single layer fades", () => {
    const many = areaScene({ label: "Worth", layers }, 300, false).scene;
    expect(many.gradients).toEqual([]);
    expect(many.nodes.filter((n) => n.k === "path" && n.opacity === 0.8)).toHaveLength(2);
    expect(many.nodes.some((n) => n.k === "path" && n.stroke === "text")).toBe(true);
    const one = areaScene({ label: "Worth", layers: layers.slice(0, 1) }, 300, false).scene;
    expect(one.gradients).toHaveLength(1);
  });

  it("summarises layers and the total; privacy hides the axis and the amounts", () => {
    const shown = areaScene({ label: "Worth", layers }, 300, false);
    expect(shown.summary).toContain("total: latest 16");
    const hidden = areaScene({ label: "Worth", layers }, 300, true);
    expect(texts(hidden.scene.nodes)).toEqual([]);
    expect(hidden.summary).not.toMatch(/\d/);
  });
});

describe("barScene", () => {
  it("draws planned bars at the plan height, a dashed plan line and its label", () => {
    const { scene } = barScene(
      { label: "Contributions", values: [2000, 0], kinds: ["main", "plan"], plan: 2000 },
      300,
      false,
    );
    const rects = scene.nodes.filter((n) => n.k === "rect");
    expect(rects.map((r) => r.k === "rect" && r.fill)).toEqual(["series1", "plan"]);
    expect(texts(scene.nodes)).toEqual(["plan"]);
  });

  it("speaks every value; privacy drops value labels and hides the amounts", () => {
    const p = {
      label: "Contributions",
      values: [2000, 0],
      labels: ["Jan", "Feb"],
      valueLabels: ["2k", null],
    };
    expect(barScene(p, 300, false).summary).toBe("Contributions: Jan 2k, Feb none");
    const hidden = barScene(p, 300, true);
    expect(hidden.summary).toBe("Contributions: Jan hidden, Feb none");
    expect(texts(hidden.scene.nodes)).toEqual(["Jan", "Feb"]);
  });
});

describe("donutScene", () => {
  it("draws one even-odd path per positive segment and speaks the shares", () => {
    const b = donutScene({
      label: "Allocation",
      segments: [
        { value: 3, color: 1, name: "Stocks" },
        { value: 0, color: 2, name: "Bonds" },
        { value: 1, color: 3, name: "Cash" },
      ],
    });
    expect(b.scene.nodes.map((n) => n.k === "path" && n.fill)).toEqual(["series1", "series3"]);
    expect(b.summary).toBe("Allocation: Stocks 75%, Cash 25%");
  });
});

describe("sparkScene", () => {
  it("tones by first vs last unless overridden; too short draws nothing", () => {
    expect(sparkScene({ values: [1, 2] }).scene.nodes[0]).toMatchObject({ stroke: "positive" });
    expect(sparkScene({ values: [2, 1], tone: "muted" }).scene.nodes[0]).toMatchObject({
      stroke: "muted",
    });
    expect(sparkScene({ values: [1] }).scene.nodes).toEqual([]);
  });
});

describe("maskTip", () => {
  it("masks amount rows only, and only in privacy mode", () => {
    const tip = {
      title: "Jan",
      rows: [
        { name: "A", value: "1 000", amount: true },
        { name: "B", value: "5%" },
      ],
    };
    expect(maskTip(tip, false)).toBe(tip);
    expect(maskTip(tip, true).rows.map((r) => r.value)).toEqual([MASK, "5%"]);
  });
});
