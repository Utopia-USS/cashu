// The topic drawer mountable (ab24ab6 v2/Home.tsx:428-432, route `topics/<key>`): the asset drawer's panel over
// the Home with a topic's (or a macro regime's) detail. Mount it inside the Home's ToastProvider.
import { TopicDrawerView } from "./TopicDrawerView.js";
import { type TopicDrawerOptions, useTopicDrawer } from "./useTopicDrawer.js";

export function TopicDrawerScreen(props: TopicDrawerOptions) {
  const { model, a } = useTopicDrawer(props);
  return <TopicDrawerView key={model.key} m={model} a={a} />;
}
