// What an empty chat on a run says and suggests, by the run's state. DOM-free.
import type { RunStatus } from "../types.ts";

/** A piece of the text: plain, or (b) the run's name, which the view draws bold. */
export type RunChatPart = string | { b: string };
export type RunChat = { text: RunChatPart[]; suggestions: string[] };

/** The four states the texts tell apart. A run that is stopping still runs. */
export type RunChatState = "draft" | "live" | "halted" | "ended";
export function runChatState(status: RunStatus | undefined): RunChatState {
  switch (status) {
    case "running": case "stopping": return "live";
    case "stopped": case "stalled": case "error": return "halted";
    case "completed": case "gave_up": return "ended";
    default: return "draft"; // a draft, or a run the client does not have (yet)
  }
}

/** The empty text and the suggestions of a chat on the run `name` in `status`. */
export function runChat(status: RunStatus | undefined, name: string | undefined): RunChat {
  const run = { b: name || "this run" };
  switch (runChatState(status)) {
    case "draft": return {
      text: ["This chat can read ", run, " once it runs. The run has not started: type its goal on the right."],
      suggestions: [],
    };
    case "live": return {
      text: ["Ask what ", run, " is doing, what a task found or why something failed. This chat reads the run's state, and can steer it: add, cancel or retry tasks, or pass a message to the orchestrator."],
      suggestions: ["What is the run doing right now?", "Summarize what is done and what is left", "Did anything fail or get stuck? Why?"],
    };
    case "halted": return {
      text: [{ b: name || "This run" }, " is stopped. Ask why, what is left, or what a task found."],
      suggestions: ["Why did the run stop, and what is left?", "What should change before I resume it?"],
    };
    case "ended": return {
      text: [{ b: name || "This run" }, " has ended. Ask what it did, what a task found, or what to check before using the result."],
      suggestions: ["Summarize what the run did", "Which tasks failed or were retried, and why?", "What should I check before using the result?"],
    };
  }
}

/** The text as one string (a title, a test). */
export const runChatText = (c: RunChat): string => c.text.map((p) => (typeof p === "string" ? p : p.b)).join("");
