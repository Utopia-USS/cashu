// A banner on a phone screen: a tile in the warning tone (or a plain one for info) whose header is an icon
// and a title, the body under it.
import { Text, View } from "react-native";
import { Icon, type IconName } from "../icons/Icon.js";
import { Tile } from "../surfaces/Tile.js";

export interface BannerProps {
  /** `warning` takes the warning tile; `info` the default tile with an accent icon. */
  tone: "warning" | "info";
  icon: IconName;
  title: string;
  body: string;
}

/** A tile that asks for attention: icon + title, then the body. */
export function Banner({ tone, icon, title, body }: BannerProps) {
  return (
    <Tile tone={tone === "warning" ? "warning" : "default"}>
      <View
        accessible
        accessibilityRole={tone === "warning" ? "alert" : "summary"}
        className="gap-1.5"
      >
        <View className="flex-row items-center gap-2">
          <Icon
            name={icon}
            size={20}
            className={tone === "warning" ? "text-warning" : "text-info"}
          />
          <Text className="shrink text-title font-strong text-fg">{title}</Text>
        </View>
        <Text className="text-body text-fg-secondary">{body}</Text>
      </View>
    </Tile>
  );
}
