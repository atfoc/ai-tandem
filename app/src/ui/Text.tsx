// The text of the app: React Native's Text in the page's type (13 px over 1.45, the sans stack, the theme's text
// colour). `tone` picks a colour of the theme, `size` and `weight` the type, `mono` the monospace stack.
import type { Ref } from "react";
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";

import { MONO, SANS } from "./fonts.ts";
import { useTokens } from "./theme.tsx";
import type { Tokens } from "./tokens.ts";

export type Tone = "text" | "muted" | "faint" | "accent" | "danger" | "warn" | "ok" | "onAccent" | "onDanger";

export const BASE_SIZE = 13;
const LINE = 1.45;

export type TextProps = RNTextProps & {
  tone?: Tone;
  size?: number;
  weight?: TextStyle["fontWeight"];
  mono?: boolean;
  /** The element, for what a screen does to it (the web's tooltip): React 19 passes it as a prop. */
  ref?: Ref<RNText>;
};

/** The colour of a tone, in the tokens of the theme shown. */
export function toneColour(t: Tokens, tone: Tone): string {
  return tone === "text" ? t.text : tone === "onAccent" ? t.onAccent : tone === "onDanger" ? t.onDanger : t[tone];
}

export function Text({ tone = "text", size = BASE_SIZE, weight, mono, style, ...rest }: TextProps) {
  const t = useTokens();
  return (
    <RNText {...rest}
      style={[{ color: toneColour(t, tone), fontSize: size, lineHeight: Math.round(size * LINE * 100) / 100, fontFamily: mono ? MONO : SANS, fontWeight: weight }, style]} />
  );
}
