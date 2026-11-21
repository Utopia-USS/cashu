// Jest boundary for Reanimated 4 in the packages/ui native tests. The published
// `react-native-reanimated/mock` loads Reanimated's web runtime, which needs react-native-web (not a
// dependency here); this stand-in covers the API the phone components use: animated values settle at
// their target at once, animated styles are computed on render, `Animated.View` is a plain View.
import { View } from "react-native";

interface Value<T> {
  get(): T;
  set(next: T): void;
  value: T;
}

function useSharedValue<T>(initial: T): Value<T> {
  let current = initial;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
    get value() {
      return current;
    },
    set value(next) {
      current = next;
    },
  };
}

function settle<T>(target: T, _config?: unknown, done?: (finished: boolean) => void): T {
  done?.(true);
  return target;
}

function interpolate(value: number, input: number[], output: number[]): number {
  const [x0 = 0, x1 = 1] = input;
  const [y0 = 0, y1 = 1] = output;
  const t = Math.min(1, Math.max(0, (value - x0) / (x1 - x0)));
  return y0 + (y1 - y0) * t;
}

const curve = (t: number) => t;
const Easing = { linear: curve, cubic: curve, out: () => curve, in: () => curve };

const useAnimatedStyle = <S,>(style: () => S): S => style();

// What react-native-gesture-handler probes when Reanimated is installed: its detectors wrap themselves as
// animated components and route worklet callbacks through Reanimated's event hooks (inert here).
const createAnimatedComponent = <C,>(component: C): C => component;
const isSharedValue = (_value: unknown) => false;
const useEvent = () => () => {};
const useHandler = () => ({ doDependenciesDiffer: false, context: {} });
const useComposedEventHandler = () => () => {};
const setGestureState = () => {};

export default { View, createAnimatedComponent };
export {
  Easing,
  interpolate,
  isSharedValue,
  setGestureState,
  settle as withSpring,
  settle as withTiming,
  useAnimatedStyle,
  useComposedEventHandler,
  useEvent,
  useHandler,
  useSharedValue,
};
