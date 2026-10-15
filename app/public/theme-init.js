// The saved theme (localStorage "aiwb.theme"), set before the first paint so the page never
// flashes another one: light or dark in data-theme and, for a Catppuccin flavour, the flavour
// beside it. Same rule as src/logic/theme.ts resolveTheme and flavourOf (test/theme.test.ts runs
// this script against them); theme.ts takes over.
try {
  var t = localStorage.getItem("aiwb.theme"), d = document.documentElement.dataset;
  if (t === "latte" || t === "frappe" || t === "macchiato" || t === "mocha") { d.flavour = t; t = t === "latte" ? "light" : "dark"; }
  else if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  d.theme = t;
} catch (e) {}
