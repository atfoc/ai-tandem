// The phone's menu of the board (B1): Excalidraw's own `MainMenu` with the items the phone has, in the footer's first place. Nothing
// else of Excalidraw's menu (Open, Save to…, Help, its links, the theme, the background) is on it; what each item does is the endpoint's.
import React from "react";
import { MainMenu } from "@excalidraw/excalidraw";
import type { PhoneChromeMsg } from "@aiwb/board-bridge/messages.ts";
import type { MenuItem } from "./Board.tsx";
import { DANGER_CLASS } from "./phonechrome.ts";

/** An icon in Excalidraw's own style: 20 px, a 1.5 px stroke of the text's colour. */
const icon = (...paths: string[]) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => <path key={d} d={d} />)}
  </svg>
);
const ICONS = {
  find: icon("M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z", "m15.5 15.5 5 5"),
  fit: icon("M4 9V5a1 1 0 0 1 1-1h4", "M15 4h4a1 1 0 0 1 1 1v4", "M20 15v4a1 1 0 0 1-1 1h-4", "M9 20H5a1 1 0 0 1-1-1v-4"),
  export: icon("M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z", "m4 15 4-4 4 4 3-3 5 5", "M9 9h.01"),
  share: icon("M12 15V4", "m8 8 4-4 4 4", "M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"),
  clear: icon("M20 5H9l-6 7 6 7h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z", "m12 9 6 6", "m18 9-6 6"),
};

export function PhoneMenu({ chrome, viewMode, onItem }: { chrome: PhoneChromeMsg; viewMode: boolean; onItem(item: MenuItem): void }) {
  const item = (key: MenuItem, text: string, className?: string) => (
    <MainMenu.Item icon={ICONS[key]} onSelect={() => onItem(key)} className={className} data-testid={`phone-menu-${key}`}>{text}</MainMenu.Item>
  );
  return (
    <MainMenu>
      <MainMenu.Group title={chrome.title}>
        {item("find", "Find on the board")}
        {item("fit", "Fit the whole board")}
        {item("export", "Export image…")}
        {chrome.share && item("share", "Share image…")}
      </MainMenu.Group>
      {!viewMode && <MainMenu.Separator />}
      {!viewMode && item("clear", "Clear the board…", DANGER_CLASS)}
    </MainMenu>
  );
}
