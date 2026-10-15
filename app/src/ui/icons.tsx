// Glyphs and small icons used across the app: the old page's icons.tsx on react-native-svg. An icon is drawn in `color`
// (the page took `currentColor` from the CSS around it; a native Svg inherits nothing), by default the text colour of
// the theme.
import type { ReactNode } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import type { AgentKind } from "@aiwb/core/types.ts";
import { agentMeta, type GlyphKind } from "@aiwb/core/agents.ts";
import { useTokens } from "./theme.tsx";

// The app draws each agent through the metadata module, so a new kind (pi) and an unknown one
// both render without touching this file's callers.
export { agentName, agentClass } from "@aiwb/core/agents.ts";

export type IconProps = { size?: number; color?: string };

/** The box every icon is drawn in (16 × 16 unless `box` says); `children` take the stroke (or the fill) given here. */
function Icon({ size, color, box = 16, width, fill = false, children, ...line }: {
  size: number; color?: string; box?: number; width?: number; fill?: boolean;
  strokeLinecap?: "round"; strokeLinejoin?: "round"; children: ReactNode;
}) {
  const t = useTokens(), c = color ?? t.text;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`}
      {...(fill ? { fill: c } : { fill: "none", stroke: c, strokeWidth: width })} {...line}>
      {children}
    </Svg>
  );
}

/** The colour each agent's glyph is drawn in, if the caller names none. */
function glyphColour(glyph: GlyphKind, t: ReturnType<typeof useTokens>): string {
  return glyph === "claude" ? t.claude : glyph === "cursor" ? t.cursor : glyph === "pi" ? t.pi : t.muted;
}

export function AgentGlyph({ agent, size = 14, color }: { agent: AgentKind | string; size?: number; color?: string }) {
  const t = useTokens();
  const m = agentMeta(agent), c = color ?? glyphColour(m.glyph, t);
  const label = { accessibilityRole: "image" as const, accessibilityLabel: m.name };
  if (m.glyph === "cursor") return (
    <Svg width={size} height={size} viewBox="0 0 16 16" {...label}>
      <Path d="M8 1 14 4.5v7L8 15 2 11.5v-7z" fill={c} opacity=".9" />
      <Path d="M8 1v7l6 3.5M8 8 2 11.5" stroke={t.bg} strokeWidth="1.1" fill="none" />
    </Svg>
  );
  if (m.glyph === "pi") return (
    <Svg width={size} height={size} viewBox="0 0 16 16" {...label}>
      <Rect x="2.5" y="4" width="11" height="2" rx="1" fill={c} />
      <Rect x="4.5" y="4" width="2" height="8" rx="1" fill={c} />
      <Rect x="9.5" y="4" width="2" height="8" rx="1" fill={c} />
    </Svg>
  );
  if (m.glyph === "claude") return (
    <Svg width={size} height={size} viewBox="0 0 16 16" {...label}>
      {[0, 30, 60, 90, 120, 150].map((a) => <Rect key={a} x="7.1" y="1" width="1.8" height="14" rx=".9" fill={c} transform={`rotate(${a} 8 8)`} />)}
    </Svg>
  );
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" {...label}>
      <Circle cx="8" cy="8" r="5.2" fill="none" stroke={c} strokeWidth="1.8" opacity=".85" />
    </Svg>
  );
}

const round = { strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const BoardIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.4}>
    <Rect x="1.5" y="2.5" width="13" height="9.5" rx="1.5" /><Path d="M4.5 9.5 7 6.5l2 2 2.5-3" strokeLinecap="round" strokeLinejoin="round" /><Path d="M8 12v2.5M5.5 14.5h5" />
  </Icon>
);

/** A chat of no agent in particular: a speech bubble ("+" names no agent). */
export const ChatIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.4} strokeLinejoin="round">
    <Path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5V11h-.5a1 1 0 0 1-1-1z" />
  </Icon>
);

export const Chevron = ({ size = 10, color }: IconProps) => (
  <Icon size={size} color={color} box={10} width={1.6} strokeLinecap="round" strokeLinejoin="round"><Path d="M3.5 2 6.5 5l-3 3" /></Icon>
);

export const GroupIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.5}><Path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></Icon>
);

export const Folder = ({ size = 12, color }: IconProps) => (
  <Icon size={size} color={color} width={1.5}><Path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></Icon>
);

export const Lock = ({ size = 10, color }: IconProps) => (
  <Icon size={size} color={color} width={1.8}><Rect x="3" y="7" width="10" height="7" rx="1.5" /><Path d="M5 7V5a3 3 0 0 1 6 0v2" /></Icon>
);

export const Pencil = ({ size = 11, color }: IconProps) => (
  <Icon size={size} color={color} width={1.6}><Path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" /></Icon>
);

export const EyeIcon = ({ size = 12, color }: IconProps) => (
  <Icon size={size} color={color} width={1.5}><Path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" /><Circle cx="8" cy="8" r="2" /></Icon>
);

export const WarnIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.5} strokeLinejoin="round"><Path d="M8 1.8 15 14H1z" /><Path d="M8 6.2v3.6M8 11.6v.4" strokeLinecap="round" /></Icon>
);

export const BranchIcon = ({ size = 11, color }: IconProps) => (
  <Icon size={size} color={color} width={1.6} strokeLinecap="round">
    <Circle cx="4" cy="3.5" r="1.7" /><Circle cx="4" cy="12.5" r="1.7" /><Circle cx="12" cy="5" r="1.7" />
    <Path d="M4 5.2v5.6M12 6.7c0 3.2-8 1.8-8 4.1" />
  </Icon>
);

export const MoreIcon = ({ size = 12, color }: IconProps) => (
  <Icon size={size} color={color} fill><Circle cx="3" cy="8" r="1.4" /><Circle cx="8" cy="8" r="1.4" /><Circle cx="13" cy="8" r="1.4" /></Icon>
);

/** Lines of text and a plus: a prompt put into the message (the composers' Insert button). */
export const InsertIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.5} strokeLinecap="round"><Path d="M2.5 4h11M2.5 8h6M2.5 12h3.5M12 9v5.5M9.25 11.75h5.5" /></Icon>
);

export const Logo = ({ size = 18 }: { size?: number }) => {
  const t = useTokens();
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18">
      <Rect x="1" y="1" width="16" height="16" rx="4" fill={t.accentFill} />
      <Path d="M5 12.5 8 5l2 5 1.2-2.2L13 12.5" stroke={t.onAccent} strokeWidth="1.6" fill="none" {...round} />
    </Svg>
  );
};

export const SunIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.4} strokeLinecap="round"><Circle cx="8" cy="8" r="2.8" /><Path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></Icon>
);

export const MoonIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.4} strokeLinejoin="round"><Path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" /></Icon>
);

export const SystemIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.4} strokeLinecap="round"><Rect x="1.5" y="2.5" width="13" height="9" rx="1.5" /><Path d="M5.5 14.5h5M8 11.5v3" /></Icon>
);

/** A cup: a Catppuccin flavour, in the theme's picker. */
export const CupIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} width={1.4} {...round}><Path d="M2.5 6.5h8.5v3.2a3.8 3.8 0 0 1-3.8 3.8h-.9a3.8 3.8 0 0 1-3.8-3.8z" /><Path d="M11 7.5h1a1.75 1.75 0 0 1 0 3.5h-.3M5 2v2M8 2v2" /></Icon>
);

/** A window with its sidebar: on the control that hides the sidebar, and on the rail's that shows it. */
export const SideIcon = ({ size = 14, color }: IconProps) => (
  <Icon size={size} color={color} width={1.4} strokeLinejoin="round"><Rect x="1.5" y="2.5" width="13" height="11" rx="2" /><Path d="M6 2.5v11" /></Icon>
);
