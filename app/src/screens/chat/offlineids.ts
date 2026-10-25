// The testIDs a chat of another server adds on the phone (ux-t3 chunk 5). `remote-off` and its parts, `remote-servers` and `remote-retry`
// are the old ones (Remote.tsx); the toast is the kit's `toast`.
export const OFFLINE_ID = {
  /** The server's state word in the thread's place (dataSet `word`, `tone`: StateWord). */
  state: "remote-off-word",
  /** "since 14:02" beside the word. */
  since: "remote-off-since",
} as const;
