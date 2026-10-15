// What the Markdown of a message needs from the screen around it, and the app's store would otherwise have to be reached
// for here (the page's Markdown.tsx reads the store and the board's view itself): the chat view (S4) provides it.
// Without a provider a chip is inert and an @name stays text.
import { createContext, useContext, type ReactNode } from "react";

import type { Board } from "@aiwb/core/types.ts";
import type { AgentKind } from "@aiwb/core/types.ts";
import type { Ref } from "@aiwb/core/logic/refs.ts";

export type MarkdownEnv = {
  /** A press on a reference chip of a board's chat: shows that reference on the board (board.ts showRef). */
  showRef?(board: string, ref: Ref, agent: AgentKind | "unknown"): void;
  /** A hook: the boards of the server (the entry id) an @name is looked up among, never those of another server. */
  useBoards?(server: string): Record<string, Board>;
  /** A press on a mention: opens that board. */
  openBoard?(id: string): void;
};

const EnvContext = createContext<MarkdownEnv>({});

export function MarkdownEnvProvider({ env, children }: { env: MarkdownEnv; children: ReactNode }) {
  return <EnvContext.Provider value={env}>{children}</EnvContext.Provider>;
}

export const useMarkdownEnv = () => useContext(EnvContext);

/** Where a message's chips and mentions point: the chat's board, drawn in its agent's colour, and the server the text is of. */
export type Where = { board?: string; agent?: AgentKind | ""; server?: string };
export const WhereContext = createContext<Where>({});
