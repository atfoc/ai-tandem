// Holding one of a run's own agents while its transcript is on screen.
import { useEffect } from "react";
import { useStore } from "../store.ts";
import { holdAgent } from "../conn.ts";
import type { ChatView } from "../types.ts";

/** Holds a run agent while the caller is mounted (conn.ts holdAgent: its view and its thread are
 *  fetched and kept current, and dropped a few seconds after the last release, so a long run's
 *  agents are never all in memory); its view, undefined until it is fetched. Holds are counted:
 *  any number of callers may hold the same agent. */
export function useAgent(chatId: string | null | undefined): ChatView | undefined {
  useEffect(() => (chatId ? holdAgent(chatId) : undefined), [chatId]);
  return useStore((s) => (chatId ? s.agents[chatId] : undefined));
}
