// Mobile renderer of the chart scenes: react-native-svg for the marks, React Native <Text> overlays for the
// labels (tabular figures and Dynamic Type, which svg text lacks), colours resolved from the theme's CSS
// variables through Uniwind (follows the system appearance). The frame owns the width (onLayout), the
// touch scrub and the VoiceOver / TalkBack adjustable value.
import { useState } from "react";
import type { AccessibilityActionEvent, GestureResponderEvent } from "react-native";
import { Text, View } from "react-native";
import { Circle, Defs, Line, LinearGradient, Path, Rect, Stop, Svg } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { layoutClass } from "../layout.js";
import { S } from "./charts.strings.js";
import { type ChartFrameProps, stepIndex, tipText } from "./frame.js";
import { nearestIndex } from "./geometry.js";
import { type ChartRole, ROLE_VAR, type Scene, type SceneNode, type TextNode } from "./scene.js";

const ROLES = Object.keys(ROLE_VAR) as ChartRole[];
const VARS = ROLES.map((r) => ROLE_VAR[r]);

/** The theme value of every role, live with the appearance. */
function usePalette(): (role: ChartRole) => string | undefined {
  const values = useCSSVariable(VARS);
  return (role) => {
    const v = values[ROLES.indexOf(role)];
    return v == null ? undefined : String(v);
  };
}

/** Text baseline below the top of a caption line box (12 / 16 type): svg `y` is a baseline, RN `top` a box. */
const BASELINE = 12;
/** Width of the box a centred label is laid out in. */
const CENTER_BOX = 96;

function labelPosition(t: TextNode, sceneWidth: number) {
  const top = t.y - BASELINE;
  if (t.anchor === "start") return { left: t.x, top };
  if (t.anchor === "end") return { right: sceneWidth - t.x, top };
  return { left: t.x - CENTER_BOX / 2, width: CENTER_BOX, top, textAlign: "center" as const };
}

function Mark({
  node,
  color,
  onActivate,
}: {
  node: SceneNode;
  color: (r: ChartRole) => string | undefined;
  onActivate?: ((index: number) => void) | undefined;
}) {
  switch (node.k) {
    case "line":
      return (
        <Line
          x1={node.x1}
          y1={node.y1}
          x2={node.x2}
          y2={node.y2}
          stroke={color(node.stroke)}
          strokeWidth={node.width ?? 1}
          strokeDasharray={node.dash}
        />
      );
    case "path":
      return (
        <Path
          d={node.d}
          accessible={node.activation !== undefined}
          accessibilityLabel={node.activation?.label}
          onPress={node.activation ? () => onActivate?.(node.activation?.index ?? 0) : undefined}
          stroke={node.stroke ? color(node.stroke) : undefined}
          fill={
            node.fill == null
              ? "none"
              : typeof node.fill === "object"
                ? `url(#${node.fill.gradient})`
                : color(node.fill)
          }
          fillRule={node.evenOdd ? "evenodd" : undefined}
          strokeWidth={node.stroke ? (node.width ?? 1) : undefined}
          strokeDasharray={node.dash}
          strokeLinejoin={node.stroke ? "round" : undefined}
          strokeLinecap={node.stroke ? (node.cap ?? "round") : undefined}
          opacity={node.opacity}
        />
      );
    case "rect":
      return (
        <Rect
          x={node.x}
          y={node.y}
          width={node.w}
          height={node.h}
          rx={node.rx}
          fill={color(node.fill)}
          opacity={node.opacity}
        />
      );
    case "circle":
      return (
        <Circle
          cx={node.cx}
          cy={node.cy}
          r={node.r}
          fill={color(node.fill)}
          stroke={node.stroke ? color(node.stroke) : node.ring ? color("surface") : undefined}
          strokeWidth={node.stroke ? (node.strokeWidth ?? 1) : node.ring ? 2 : undefined}
        />
      );
    case "text":
      return null;
  }
}

function SvgScene({
  scene,
  color,
  onActivate,
}: {
  scene: Scene;
  color: (r: ChartRole) => string | undefined;
  onActivate?: ((index: number) => void) | undefined;
}) {
  const { width: w, height: h } = scene;
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {scene.gradients.length > 0 && (
        <Defs>
          {scene.gradients.map((g) => (
            <LinearGradient
              key={g.id}
              id={g.id}
              gradientUnits="userSpaceOnUse"
              x1={0}
              x2={0}
              y1={g.y1}
              y2={g.y2}
            >
              <Stop offset={0} stopColor={color(g.color)} stopOpacity={g.strong} />
              <Stop offset={1} stopColor={color(g.color)} stopOpacity={0} />
            </LinearGradient>
          ))}
        </Defs>
      )}
      {scene.nodes.map((node, k) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: scene nodes have no identity beyond their order
        <Mark key={k} node={node} color={color} onActivate={onActivate} />
      ))}
    </Svg>
  );
}

/** Measures, draws and makes a chart scene scrubbable on mobile. */
export function ChartFrame({
  width: fixed,
  height,
  layout,
  label,
  build,
  tooltip,
  center,
  decorative,
  inline,
  onActivate,
  onScrub,
}: ChartFrameProps) {
  const [measured, setMeasured] = useState(0);
  const [hover, setFocus] = useState<number | null>(null);
  // Every focus change reports to the caller's scrub, which then shows the point itself (no floating tip).
  const setHover = (next: number | null) => {
    setFocus(next);
    if (onScrub && next !== hover) onScrub(next);
  };
  const color = usePalette();
  const width = fixed ?? measured;
  const built = width > 0 ? build(width) : null;
  const scrub = tooltip && built?.scrub ? built.scrub : null;
  const summary = built?.summary || label;
  const focused = scrub && hover != null && hover < scrub.n ? hover : null;
  const focus = scrub && focused != null ? scrub.focus(focused) : null;
  const tip = tooltip && focused != null ? tooltip(focused) : null;

  const pick = (e: GestureResponderEvent) => {
    if (scrub) setHover(nearestIndex(e.nativeEvent.locationX, scrub.n, scrub.x0, scrub.x1));
  };
  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (onActivate && e.nativeEvent.actionName.startsWith("segment-")) {
      const index = Number(e.nativeEvent.actionName.slice(8));
      if (built?.scene.nodes.some((node) => node.k === "path" && node.activation?.index === index))
        onActivate(index);
      return;
    }
    if (!scrub) return;
    const delta = { increment: 1, decrement: -1 }[e.nativeEvent.actionName];
    if (delta != null) setHover(stepIndex(hover, delta, scrub.n));
  };
  const a11y = decorative
    ? {
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants" as const,
      }
    : scrub
      ? {
          accessible: true,
          accessibilityRole: "adjustable" as const,
          accessibilityLabel: summary,
          accessibilityHint: S.adjustHint,
          accessibilityValue: tip ? { text: tipText(tip) } : undefined,
          accessibilityActions: [{ name: "increment" }, { name: "decrement" }],
          onAccessibilityAction,
        }
      : onActivate
        ? {
            accessible: true,
            accessibilityRole: "image" as const,
            accessibilityLabel: summary,
            accessibilityActions: built?.scene.nodes.flatMap((node) =>
              node.k === "path" && node.activation
                ? [{ name: `segment-${node.activation.index}`, label: node.activation.label }]
                : [],
            ),
            onAccessibilityAction,
          }
        : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: summary };
  const scene = built?.scene;
  const right = focus != null && scene != null && focus.x > scene.width * 0.6;

  return (
    <View
      className={[inline ? "self-start" : "w-full", "overflow-visible", layoutClass(layout)].join(
        " ",
      )}
      style={{ height, width: fixed }}
      onLayout={
        fixed == null ? (e) => setMeasured(Math.round(e.nativeEvent.layout.width)) : undefined
      }
      onStartShouldSetResponder={scrub ? () => true : undefined}
      onMoveShouldSetResponder={scrub ? () => true : undefined}
      onResponderGrant={scrub ? pick : undefined}
      onResponderMove={scrub ? pick : undefined}
      onResponderRelease={scrub ? () => setHover(null) : undefined}
      onResponderTerminate={scrub ? () => setHover(null) : undefined}
      {...a11y}
    >
      {scene && (
        <View pointerEvents={onActivate ? "box-none" : "none"} className="absolute inset-0">
          <SvgScene scene={scene} color={color} onActivate={onActivate} />
          {focus && (
            <Svg width={scene.width} height={scene.height} className="absolute inset-0">
              <Line
                x1={focus.x}
                x2={focus.x}
                y1={focus.top}
                y2={focus.bottom}
                stroke={color("muted")}
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              {focus.dots.map((d) => (
                <Circle
                  key={`${d.fill}${d.cy}`}
                  cx={focus.x}
                  cy={d.cy}
                  r={3.5}
                  fill={color(d.fill)}
                  stroke={color("surface")}
                  strokeWidth={2}
                />
              ))}
            </Svg>
          )}
          {scene.nodes.map((node, k) =>
            node.k === "text" ? (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: scene nodes have no identity beyond their order
                key={k}
                numberOfLines={1}
                className={[
                  "absolute text-caption tabular-nums",
                  node.tone === "muted" ? "text-fg-muted" : "text-fg",
                ].join(" ")}
                style={labelPosition(node, scene.width)}
              >
                {node.text}
              </Text>
            ) : null,
          )}
          {center && (
            <View className="absolute inset-0 items-center justify-center">
              <Text className="text-title font-strong tabular-nums text-fg">{center.title}</Text>
              {center.caption && (
                <Text className="text-caption text-fg-muted">{center.caption}</Text>
              )}
            </View>
          )}
        </View>
      )}
      {tip && focus && scene && !onScrub && (
        <View
          pointerEvents="none"
          className="absolute rounded-md border border-border bg-surface-raised px-2 py-1"
          style={{
            ...(right ? { right: scene.width - focus.x + 8 } : { left: focus.x + 8 }),
            top: focus.tipBelow ? focus.tipY : focus.top,
          }}
        >
          <Text className="text-caption font-strong text-fg">{tip.title}</Text>
          {tip.rows.map((r) => (
            <Text key={r.name} className="text-caption text-fg">
              <Text className="text-fg-muted">{r.name}</Text>{" "}
              <Text className="font-strong tabular-nums">{r.value}</Text>
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}
