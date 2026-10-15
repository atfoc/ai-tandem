// The design tokens (AD-74): the variables the old page's styles.css gives the light theme and the dark one, and
// the old page's flavours.css gives the four Catppuccin flavours, as maps {name: value} the components read with
// useTokens(). A name is the CSS variable's in camelCase: --accent-fill is accentFill, --line-2 is line2,
// --viz-1 is viz1. test/tokens.test.ts holds every value to the two CSS files (and, once they are retired, to
// test/fixtures/tokens.json, which it writes from them). No React and no react-native here, so Node loads it.
//
// The flavours are not copied: logic/flavours.ts in core is where they are made (flavours.css is written from it),
// so tokensFor() takes them from there, laid over the theme the flavour sits on as flavours.css lays them over
// styles.css (a token a flavour does not set stays the theme's).
import { flavourTokens } from "@aiwb/core/logic/flavours.ts";
import { flavourOf, resolveTheme, type Flavour, type Theme, type ThemePref } from "@aiwb/core/logic/theme.ts";

const light = {
  bg: "#ffffff",
  panel: "#fbfbfc",
  line: "#e7e7ec",
  line2: "#d9d9e0",
  text: "#1c1c22",
  muted: "#6e6e7a",
  faint: "#a0a0ab",
  accent: "#6965db", // Excalidraw's own violet; text, borders, rings
  accentFill: "#6965db", // behind white text
  accentSoft: "#eeedfc",
  onAccent: "#ffffff",
  userText: "#2b2870", // the user's own message, on accentSoft
  claude: "#d97757",
  claudeSoft: "#fbeee8",
  cursor: "#26262b",
  cursorSoft: "#ececef",
  pi: "#0f766e",
  piSoft: "#e6f4f2",
  warn: "#e8a317",
  warnSoft: "#fffaf0",
  danger: "#e03131",
  dangerFill: "#e03131",
  onDanger: "#ffffff", // text on dangerFill
  dangerSoft: "#fdecec",
  ok: "#2f9e44",
  hover: "rgba(0, 0, 0, .04)",
  hover2: "rgba(0, 0, 0, .05)",
  knob: "#ffffff",
  knobOn: "#ffffff", // the knob of a switch that is on: a flavour's differs
  backdrop: "rgba(20, 20, 40, .28)",
  shadowSm: "0 4px 16px rgba(20, 20, 40, .1)",
  shadowMd: "0 8px 28px rgba(20, 20, 40, .14)",
  shadowLg: "0 18px 48px rgba(20, 20, 40, .24)",
  synKeyword: "#8b3fc7", // code colours in messages
  synString: "#2b8a3e",
  synNumber: "#c2410c",
  synTitle: "#1864ab",
  synType: "#0c7a8a",
  synAttr: "#a15c07",
  // categorical chart colours (the context split), in the dataviz skill's validated order
  viz1: "#2a78d6", viz2: "#eb6834", viz3: "#1baf7a", viz4: "#eda100",
  viz5: "#e87ba4", viz6: "#008300", viz7: "#4a3aa7", viz8: "#e34948",
};

export type TokenName = keyof typeof light;
/** One theme's tokens: every name has a value. */
export type Tokens = Record<TokenName, string>;

const LIGHT: Tokens = light;

// Close to Excalidraw's own dark UI so the canvas and the app read as one.
const DARK: Tokens = {
  ...LIGHT,
  bg: "#1c1c21",
  panel: "#232329",
  line: "#313139",
  line2: "#3d3d47",
  text: "#e5e5ea",
  muted: "#a1a1ad",
  faint: "#74747f",
  accent: "#a8a5ff", // Excalidraw's dark primary
  accentFill: "#6965db",
  accentSoft: "#2e2c4d",
  onAccent: "#ffffff",
  userText: "#e2e0ff",
  claude: "#e58c6d",
  claudeSoft: "#3a2721",
  cursor: "#d6d6dc",
  cursorSoft: "#2f2f36",
  pi: "#4fd1c5",
  piSoft: "#1f3533",
  warn: "#f0b545",
  warnSoft: "#2f2716",
  danger: "#ff7070",
  dangerFill: "#d9383a",
  dangerSoft: "#3b2224",
  ok: "#5cc971",
  hover: "rgba(255, 255, 255, .05)",
  hover2: "rgba(255, 255, 255, .08)",
  knob: "#f2f2f5",
  knobOn: "#f2f2f5",
  backdrop: "rgba(0, 0, 0, .55)",
  shadowSm: "0 4px 16px rgba(0, 0, 0, .4)",
  shadowMd: "0 8px 28px rgba(0, 0, 0, .5)",
  shadowLg: "0 18px 48px rgba(0, 0, 0, .6)",
  synKeyword: "#c79bff",
  synString: "#8fd694",
  synNumber: "#f5a97f",
  synTitle: "#82b8ff",
  synType: "#6fd3e0",
  synAttr: "#e8c46f",
  viz1: "#3987e5", viz2: "#d95926", viz3: "#199e70", viz4: "#c98500",
  viz5: "#d55181", viz6: "#008300", viz7: "#9085e9", viz8: "#e66767",
};

/** The light and the dark theme's tokens (styles.css `:root` and `:root[data-theme="dark"]`). */
export const THEME_TOKENS: Record<Theme, Tokens> = { light: LIGHT, dark: DARK };

/** --radius of styles.css, in points. */
export const radius = 8;
/** --font and --mono of styles.css, the page's stacks; a native Text uses the system's font and a monospace one. */
export const fontSans = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif';
export const fontMono = 'ui-monospace, "SF Mono", Menlo, monospace';

/** The tokens `--name` of logic/flavours.ts names ("--accent-fill") as ours ("accentFill"). */
export const tokenName = (cssName: string) =>
  cssName.replace(/^--/, "").replace(/-(.)/g, (_, c: string) => c.toUpperCase());

const flavoured = new Map<Flavour, Tokens>();
/** What a flavour sets, laid over the theme it sits on (Latte over light, the others over dark). */
function flavourOver(flavour: Flavour): Tokens {
  let tokens = flavoured.get(flavour);
  if (!tokens) {
    tokens = { ...THEME_TOKENS[resolveTheme(flavour, false)] };
    for (const t of flavourTokens(flavour)) (tokens as Record<string, string>)[tokenName(t.name)] = t.value;
    flavoured.set(flavour, tokens);
  }
  return tokens;
}

/** The tokens of a theme, or of a flavour laid over it. The result is the same object for the same arguments. */
export function tokensFor(theme: Theme, flavour: Flavour | null = null): Tokens {
  return flavour ? flavourOver(flavour) : THEME_TOKENS[theme];
}

export type Resolved = { theme: Theme; flavour: Flavour | null; tokens: Tokens };

/** What a choice shows: the theme (the system's when the choice is "system"), the flavour if the choice is one, and
 *  their tokens. */
export function resolveTokens(pref: ThemePref, systemDark: boolean): Resolved {
  const theme = resolveTheme(pref, systemDark), flavour = flavourOf(pref);
  return { theme, flavour, tokens: tokensFor(theme, flavour) };
}
