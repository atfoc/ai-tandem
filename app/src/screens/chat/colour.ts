// Colours the chat view derives from the theme's tokens: the colour of an agent, and a colour laid over another with an alpha
// (the page's `color-mix(in srgb, X 55%, transparent)`). No React here, so Node loads it.
import { agentClass } from "@aiwb/core/agents.ts";

import type { Tokens } from "../../ui/tokens.ts";

/** An agent's colour and its soft ground (`--agent`, `--agent-soft` of styles.css); an unknown agent is the muted one. */
export function agentColours(t: Tokens, agent: string): { fg: string; soft: string } {
  switch (agentClass(agent)) {
    case "claude": return { fg: t.claude, soft: t.claudeSoft };
    case "cursor": return { fg: t.cursor, soft: t.cursorSoft };
    case "pi": return { fg: t.pi, soft: t.piSoft };
    default: return { fg: t.muted, soft: t.hover };
  }
}

/** `#rrggbb` at an opacity, as `rgba()` (a colour that is already rgba keeps its own alpha times this one). */
export function alpha(colour: string, a: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) { const n = parseInt(hex[1], 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(colour);
  if (rgba) { const [r, g, b, k = "1"] = rgba[1].split(",").map((x) => x.trim()); return `rgba(${r}, ${g}, ${b}, ${Math.round(+k * a * 1000) / 1000})`; }
  return colour;
}
