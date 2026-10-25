// The "<Server> is back online" toast of a chat shown on the phone (ux-improvements goal 3.1.3, 3.5): the chat's server goes from not
// connected to connected while the chat is on screen. The transition is this pure function (test/backonline.test.ts); the hook that feeds
// it and shows the toast is `useBackOnline` in Remote.tsx. No React here, so Node loads it.

/** What the hook remembers: the server it looked at and whether that server was connected. */
export type Seen = { server: string; connected: boolean } | null;

/** The step from what was seen to what is seen now: the new memory, and whether the toast shows. It shows once, on the change of the same
 *  server from not connected to connected: not on the first look (a chat opened with its server connected, or not), not when the chat
 *  changes to one of another server, and not for a server that stays as it is. */
export function backOnlineStep(seen: Seen, server: string, connected: boolean): { seen: Seen; show: boolean } {
  return { seen: { server, connected }, show: !!seen && seen.server === server && !seen.connected && connected };
}

export const backOnlineText = (name: string): string => `${name} is back online`;
