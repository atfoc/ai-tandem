// The testIDs of the phone's board screen (package B1, plans/ux-improvements/b1-design.md §5; the shared ones are in ui/tid.ts).
export const B1_TID = {
  bar: "board-bar", chats: "board-chats", take: "board-take", row: "board-row", orbSlot: "board-orb-slot",
  sheet: "chats-sheet", sheetNew: "chats-new", sheetRow: "chats-row", float: "board-float",
} as const;

// The board while a chat waits for a point or for shapes (ux-improvements B2, plans/ux-improvements/b2-design.md §7).
export const B2_TID = {
  bar: "pick-bar", cancel: "pick-cancel", add: "pick-add", take: "pick-take", pin: "pick-pin", pinLabel: "pick-pin-label", border: "pick-border",
} as const;
