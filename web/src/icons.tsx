// Glyphs and small icons used across the app.
import React from "react";
import type { AgentKind } from "./types.ts";
import { agentMeta } from "./agents.ts";

// The app draws each agent through the metadata module, so a new kind (pi) and an unknown one
// both render without touching this file's callers.
export { agentName, agentClass } from "./agents.ts";

export function AgentGlyph({ agent, size = 14 }: { agent: AgentKind | string; size?: number }) {
  const m = agentMeta(agent);
  if (m.glyph === "cursor") return (
    <svg className="glyph cursor" width={size} height={size} viewBox="0 0 16 16" aria-label={m.name}>
      <path d="M8 1 14 4.5v7L8 15 2 11.5v-7z" fill="currentColor" opacity=".9" />
      <path d="M8 1v7l6 3.5M8 8 2 11.5" stroke="var(--bg)" strokeWidth="1.1" fill="none" />
    </svg>
  );
  if (m.glyph === "pi") return (
    <svg className="glyph pi" width={size} height={size} viewBox="0 0 16 16" aria-label={m.name}>
      <rect x="2.5" y="4" width="11" height="2" rx="1" fill="currentColor" />
      <rect x="4.5" y="4" width="2" height="8" rx="1" fill="currentColor" />
      <rect x="9.5" y="4" width="2" height="8" rx="1" fill="currentColor" />
    </svg>
  );
  if (m.glyph === "claude") return (
    <svg className="glyph claude" width={size} height={size} viewBox="0 0 16 16" aria-label={m.name}>
      {[0, 30, 60, 90, 120, 150].map((a) => <rect key={a} x="7.1" y="1" width="1.8" height="14" rx=".9" fill="currentColor" transform={`rotate(${a} 8 8)`} />)}
    </svg>
  );
  return (
    <svg className="glyph unknown" width={size} height={size} viewBox="0 0 16 16" aria-label={m.name}>
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.8" opacity=".85" />
    </svg>
  );
}

export const BoardIcon = ({ size = 13 }: { size?: number }) => (
  <svg className="board-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="2.5" width="13" height="9.5" rx="1.5" /><path d="M4.5 9.5 7 6.5l2 2 2.5-3" strokeLinecap="round" strokeLinejoin="round" /><path d="M8 12v2.5M5.5 14.5h5" />
  </svg>
);

export const Chevron = () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 2 6.5 5l-3 3" /></svg>;

export const GroupIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>;

export const Folder = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>;

export const Lock = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg>;

export const Pencil = () => <svg className="pencil" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" /></svg>;

export const EyeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" /><circle cx="8" cy="8" r="2" /></svg>
);

export const WarnIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M8 1.8 15 14H1z" /><path d="M8 6.2v3.6M8 11.6v.4" strokeLinecap="round" /></svg>
);

export const MoreIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></svg>
);

export const Logo = () => (
  <svg width="18" height="18" viewBox="0 0 18 18"><rect x="1" y="1" width="16" height="16" rx="4" fill="var(--accent-fill)" /><path d="M5 12.5 8 5l2 5 1.2-2.2L13 12.5" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const SunIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></svg>
);

export const MoonIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" /></svg>
);

export const SystemIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" /><path d="M5.5 14.5h5M8 11.5v3" /></svg>
);
