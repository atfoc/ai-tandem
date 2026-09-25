// Applies the colour theme to the page: `data-theme` on <html>, which styles.css keys its colour
// tokens on, and Excalidraw's `theme` prop (Canvas.tsx, from the store). index.html sets the
// attribute before the first paint; this keeps it current when the choice or the system changes.
import { getState, setState, safeSet } from "./store.ts";
import { resolveTheme, type ThemePref } from "./logic/theme.ts";

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function apply() {
  const theme = resolveTheme(getState().themePref, !!media?.matches);
  document.documentElement.dataset.theme = theme;
  if (theme !== getState().theme) setState({ theme });
}

/** Called once at start: applies the saved choice and follows the system while it is "system". */
export function initTheme() {
  apply();
  media?.addEventListener("change", apply);
}

export function setThemePref(themePref: ThemePref) {
  setState({ themePref }); safeSet("aiwb.theme", themePref);
  apply();
}
