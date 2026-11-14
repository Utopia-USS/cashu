import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type AccessibilityActionEvent,
  AccessibilityInfo,
  useWindowDimensions,
  View,
} from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

export type SwipeDirection = "left" | "right";

export interface SwipeStackProps {
  /** The top card. Give it new content when `onSwiped` advances; the stack settles back for it. */
  children: ReactNode;
  /** The next card, drawn behind the top one (scaled down, dimmed). */
  behind?: ReactNode;
  /** Called once the top card has left the stage (gesture or accessibility action). */
  onSwiped(direction: SwipeDirection): void;
  /** Swiping (and the two accessibility actions) allowed at all; default true. */
  enabled?: boolean;
  /** The left swipe (and its accessibility action) allowed while `enabled`; default true. */
  canSwipeLeft?: boolean;
  /** The right swipe (and its accessibility action) allowed while `enabled`; default true. */
  canSwipeRight?: boolean;
  /** Stage height in points (default 300, the prototype's triage stage). */
  height?: number;
  /** Translated name of the left swipe, offered to VoiceOver as an action. */
  swipeLeftLabel: string;
  /** Translated name of the right swipe, offered to VoiceOver as an action. */
  swipeRightLabel: string;
}

// Gesture geometry (points, points per second, degrees): the card leaves past 120 pt or a fast fling.
const DISTANCE = 120;
const VELOCITY = 800;
const DEG_PER_PT = 1 / 30;
const BEHIND_SCALE = 0.95;
const BEHIND_OPACITY = 0.6;
const OUT_MS = 230;
const REDUCED_MS = 120;
const SPRING = { damping: 20, stiffness: 220 } as const;

/**
 * Where a released drag sends the card: past the distance threshold, or on a fling (the fling's
 * direction wins over the drag's), it leaves to that side; a canceled gesture or a short slow drag
 * returns (null). A worklet: it runs on the UI thread in the gesture's `onDeactivate`.
 */
export function swipeOutcome(
  translationX: number,
  velocityX: number,
  canceled: boolean,
): SwipeDirection | null {
  "worklet";
  if (canceled) return null;
  const fling = Math.abs(velocityX) > VELOCITY;
  if (!fling && Math.abs(translationX) <= DISTANCE) return null;
  return (fling ? velocityX : translationX) > 0 ? "right" : "left";
}

/**
 * A released drag's outcome kept only when that direction is allowed: a refused direction returns
 * (null), so the card springs back. A worklet, like `swipeOutcome`.
 */
export function allowedSwipe(
  direction: SwipeDirection | null,
  canSwipeLeft: boolean,
  canSwipeRight: boolean,
): SwipeDirection | null {
  "worklet";
  if (direction === "left" && !canSwipeLeft) return null;
  if (direction === "right" && !canSwipeRight) return null;
  return direction;
}

/** Reduce Motion, live: the system setting at mount and every change after. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (live) setReduce(on);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * The card stage of triage and the review deck (prototype `.tri-card`, `.dcard`): the top card follows a
 * horizontal drag (translate and a slight tilt, transform only), leaves past the threshold or on a fling
 * and reports the direction, else springs back; the next card waits behind it and brightens as the top
 * one moves. Reduce Motion drops the tilt and uses a short linear exit. VoiceOver gets both directions as
 * actions on the card. `enabled` switches swiping off as a whole; `canSwipeLeft` / `canSwipeRight` refuse
 * one direction only (the drag springs back, the action is not offered).
 */
export function SwipeStack({
  children,
  behind,
  onSwiped,
  enabled = true,
  canSwipeLeft = true,
  canSwipeRight = true,
  height = 300,
  swipeLeftLabel,
  swipeRightLabel,
}: SwipeStackProps) {
  const { width } = useWindowDimensions();
  const reduce = useReduceMotion();
  const x = useSharedValue(0);
  const left = useRef(false);
  const canLeft = enabled && canSwipeLeft;
  const canRight = enabled && canSwipeRight;

  // The card that left stays off stage until the parent renders the next one; then the stack settles.
  useLayoutEffect(() => {
    if (!left.current) return;
    left.current = false;
    x.set(0);
  });

  const finish = (direction: SwipeDirection) => {
    left.current = true;
    onSwiped(direction);
  };

  const pan = usePanGesture({
    enabled: canLeft || canRight,
    activeOffsetX: [-10, 10],
    failOffsetY: [-20, 20],
    onUpdate: (event) => {
      "worklet";
      x.set(event.translationX);
    },
    onDeactivate: (event) => {
      "worklet";
      const direction = allowedSwipe(
        swipeOutcome(event.translationX, event.velocityX, event.canceled),
        canLeft,
        canRight,
      );
      if (direction !== null) {
        x.set(
          withTiming(
            direction === "right" ? width * 1.5 : -width * 1.5,
            reduce
              ? { duration: REDUCED_MS, easing: Easing.linear }
              : { duration: OUT_MS, easing: Easing.out(Easing.cubic) },
            (done?: boolean) => {
              if (done) scheduleOnRN(finish, direction);
            },
          ),
        );
      } else {
        x.set(
          reduce
            ? withTiming(0, { duration: REDUCED_MS, easing: Easing.linear })
            : withSpring(0, SPRING),
        );
      }
    },
  });

  const topStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { rotate: `${reduce ? 0 : x.get() * DEG_PER_PT}deg` }],
  }));
  const behindStyle = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(x.get()), [0, DISTANCE], [BEHIND_OPACITY, 1], "clamp"),
    transform: [{ scale: BEHIND_SCALE }],
  }));

  return (
    <View style={{ height }}>
      {behind !== undefined && (
        <Animated.View
          style={behindStyle}
          className="absolute inset-0"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {behind}
        </Animated.View>
      )}
      <GestureDetector gesture={pan}>
        <Animated.View
          style={topStyle}
          className="absolute inset-0"
          accessible
          accessibilityActions={[
            ...(canLeft ? [{ name: "swipeLeft", label: swipeLeftLabel }] : []),
            ...(canRight ? [{ name: "swipeRight", label: swipeRightLabel }] : []),
          ]}
          onAccessibilityAction={(event: AccessibilityActionEvent) => {
            if (canLeft && event.nativeEvent.actionName === "swipeLeft") onSwiped("left");
            if (canRight && event.nativeEvent.actionName === "swipeRight") onSwiped("right");
          }}
        >
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
