// Donut scene (the legacy frontend Donut): one arc per positive segment with 2 px surface gaps; the
// summary speaks each segment's share (shares stay visible in privacy mode).
import { S } from "./charts.strings.js";
import { donutArcs } from "./geometry.js";
import type { Built, SceneNode } from "./scene.js";
import { colorRole } from "./scene.js";
import type { DonutProps } from "./types.js";
import { percent } from "./values.js";

/** A segment other than the focused one (design V5 allocation: 0.22). */
const DIMMED = 0.22;

export function donutScene(p: DonutProps): Built {
  const size = p.size ?? 112;
  const arcs = donutArcs(
    p.segments.map((s) => s.value),
    size,
    p.thickness,
    p.gap,
  );
  const nodes: SceneNode[] = [];
  arcs.forEach((d, i) => {
    const seg = p.segments[i];
    if (d && seg)
      nodes.push({
        k: "path",
        d,
        fill: colorRole(seg.color),
        evenOdd: true,
        ...(p.onSegmentHover || p.focus != null ? { hover: i } : {}),
        ...(p.focus != null && p.focus !== i ? { opacity: DIMMED } : {}),
        ...(p.onSegmentSelected ? { activation: { index: i, label: seg.name } } : {}),
      });
  });
  const total = p.segments.reduce((a, s) => (s.value > 0 ? a + s.value : a), 0);
  const parts = p.segments
    .filter((s) => s.value > 0)
    .map((s) => `${s.name} ${percent(s.value, total)}`);
  return {
    scene: { width: size, height: size, gradients: [], nodes },
    scrub: null,
    summary: parts.length ? `${p.label}: ${parts.join(", ")}` : `${p.label}: ${S.noData}`,
  };
}
