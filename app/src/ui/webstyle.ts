// Style properties only a browser knows (a cursor other than "pointer", `touchAction`, `outline`…): react-native-web
// draws them, native has no such property, so the style is left out there.
import { Platform, type ViewStyle } from "react-native";

export function webStyle(style: Record<string, string | number>): ViewStyle | undefined {
  return Platform.OS === "web" ? (style as unknown as ViewStyle) : undefined;
}
