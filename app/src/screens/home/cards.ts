// The sentences of Home's state cards (plans/ux-improvements/h1-design.md §4): the problem card's, the first run's steps and the empty
// Home's agents line. Pure (no React, no react-native), so Node tests them.
import { agentName } from "@aiwb/core/agents.ts";
import { SERVER_WORDS, formatSince } from "@aiwb/core/logic/statewords.ts";
import type { AgentKind } from "@aiwb/core/types.ts";

/** The guide the first run links to (the repo's page on remote servers). */
export const SETUP_GUIDE_URL = "https://github.com/atfoc/ai-tandem/blob/main/docs/remote-servers.md";

/** The sentence of the problem card for a server in the state word `word` (a key of `SERVER_WORDS`); "" for a word that is no trouble. */
export function problemSentence(word: string, name: string, version?: string): string {
  switch (word) {
    case SERVER_WORDS.unreachable.key:
    case SERVER_WORDS.offline.key:
      return `Can't reach ${name}. Its boards and chats come back when it does.`;
    case SERVER_WORDS.certChanged.key:
      return `${name}'s certificate changed. Nothing is sent until you review it.`;
    case SERVER_WORDS.tooOld.key:
      return `${name} runs an older server${version ? ` (version ${version})` : ""}. Update the server on that computer.`;
    case SERVER_WORDS.localNetworkOff.key:
      return "Local network access is off for AI Whiteboard. Turn it on in Settings › Privacy › Local Network.";
    default:
      return "";
  }
}

/** The right of the card's first line: the word, and since when ("Unreachable · since 9:12"); the word alone when the time is not known. */
export const wordSince = (text: string, since: number | undefined, now: number): string =>
  since === undefined ? text : `${text} · ${formatSince(since, now)}`;

/** A piece of a first-run step: plain text, or a command shown in the monospace. */
export type Piece = { text: string; code?: true };

/** The three steps of "ON YOUR COMPUTER" (sh-08a). */
export const FIRST_RUN_STEPS: readonly (readonly Piece[])[] = [
  [{ text: "Set up the server once: run " }, { text: "setup-remote.sh", code: true }, { text: " (in the Mac app, or in the server folder)." }],
  [{ text: "Paste what it printed into Add a server, or show it as a code with " }, { text: "server-code.sh", code: true }, { text: " and scan it." }],
  [{ text: "Allow Local Network when the phone asks." }],
];

/** The step as one string (the accessibility label). */
export const stepText = (s: readonly Piece[]): string => s.map((p) => p.text).join("");

// The names as the sentence writes them: "pi" is not capitalised (the same as logic/agentlist.ts homeAgentsText).
const inText = (a: AgentKind): string => (a === "pi" ? "pi" : agentName(a));

/** Empty Home's line on the agents the server can run: "Claude Code, Cursor and pi are ready on Studio Mac." */
export function agentsLine(usable: readonly AgentKind[], server: string): string {
  if (!usable.length) return `No agent is installed on ${server}.`;
  const names = usable.map(inText);
  if (names.length === 1) return `${names[0]} is ready on ${server}.`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are ready on ${server}.`;
}
