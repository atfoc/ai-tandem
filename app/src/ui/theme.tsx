// The theme of the UI (AD-74): ThemeProvider holds the user's choice (light, dark, system, or a Catppuccin flavour)
// and what it shows; useTokens() gives the components the colours, useTheme() the choice and its setter. The choice,
// its resolution and its title are logic/theme.ts (core); its storage is the kv key "aiwb.theme", as on the page.
// Native follows the OS (Appearance) while the choice is "system". On web the pre-paint script of the page stays; the
// provider keeps `data-theme`, `data-flavour` and `color-scheme` of <html> current, as the old page's theme.ts does, so what
// the page paints outside React (its background, the board's view) agrees.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";

import { parseThemePref, type Flavour, type Theme, type ThemePref } from "@aiwb/core/logic/theme.ts";
import { setFocusRing } from "./focusring.ts";
import { resolveTokens, type Tokens } from "./tokens.ts";

/** The kv key of the choice (AD-12: the page's own key). */
export const THEME_KEY = "aiwb.theme";

/** The part of the kv port (AD-12, `@aiwb/core/state/ports.ts` `Kv`) the theme uses; the port itself fits it. */
export type ThemeKv = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

type ThemeValue = {
  /** The user's choice. */
  pref: ThemePref;
  /** What is shown: light or dark (a flavour is laid over one of them). */
  theme: Theme;
  /** The flavour, while the choice is one. */
  flavour: Flavour | null;
  tokens: Tokens;
  /** Chooses, and saves the choice. */
  setPref(pref: ThemePref): void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

function savedPref(kv: ThemeKv | undefined): ThemePref {
  try { return parseThemePref(kv?.get(THEME_KEY) ?? null); } catch { return "system"; }
}

export function ThemeProvider({ kv, children }: { kv?: ThemeKv; children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => savedPref(kv));
  const systemDark = useColorScheme() === "dark";
  const { theme, flavour, tokens } = useMemo(() => resolveTokens(pref, systemDark), [pref, systemDark]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    try { kv?.set(THEME_KEY, next); } catch { /* storage is full or refused: the choice holds for this run */ }
  }, [kv]);

  useEffect(() => {
    if (Platform.OS === "web") {
      const root = document.documentElement;
      root.dataset.theme = theme;
      if (flavour) root.dataset.flavour = flavour; else delete root.dataset.flavour;
      root.style.colorScheme = theme;
      setFocusRing(tokens.accent);
    } else {
      // the keyboard, alerts and the status bar follow the chosen theme; "system" gives the choice back to the OS
      Appearance.setColorScheme(pref === "system" ? "unspecified" : theme);
    }
  }, [pref, theme, flavour, tokens]);

  const value = useMemo<ThemeValue>(() => ({ pref, theme, flavour, tokens, setPref }), [pref, theme, flavour, tokens, setPref]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The theme's value; throws outside a ThemeProvider. */
export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme is used outside a ThemeProvider");
  return value;
}

/** The colours and other tokens of what is shown. */
export function useTokens(): Tokens {
  return useTheme().tokens;
}
