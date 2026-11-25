// Minimal CSF 3 shapes for the stories of packages/ui (Storybook reads the same files once it is wired, see
// cashu-ui storybook.md) and the helper that turns a story module into elements for the render tests.
import type { ComponentType, ReactElement } from "react";
import { UiEnvProvider } from "../../environment/UiEnv.js";

export type Decorator = (Story: ComponentType) => ReactElement;

export interface Meta<P> {
  title: string;
  component: ComponentType<P>;
  args: P;
  decorators?: Decorator[];
}

export interface Story<P> {
  args?: Partial<P>;
  decorators?: Decorator[];
}

/** Renders the story inside privacy mode (amounts hidden). */
export const privacyMode: Decorator = (Story) => (
  <UiEnvProvider privacy>
    <Story />
  </UiEnvProvider>
);

/** Every named story of a CSF module as [name, element], decorators applied (story first, then meta). */
export function storyCases(mod: Record<string, unknown>): [string, ReactElement][] {
  const meta = mod.default as Meta<Record<string, unknown>>;
  const Component = meta.component;
  return Object.entries(mod)
    .filter(([name]) => name !== "default")
    .map(([name, value]) => {
      const story = value as Story<Record<string, unknown>>;
      const decorators = [...(story.decorators ?? []), ...(meta.decorators ?? [])];
      const element = decorators.reduce<ReactElement>(
        (inner, decorate) => decorate(() => inner),
        <Component {...meta.args} {...story.args} />,
      );
      return [name, element];
    });
}
