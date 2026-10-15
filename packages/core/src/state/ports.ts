// The seams of the page's state layer (AD-2, AD-12): what the store, the event layer and the actions need of the client
// that runs them, and that core does not have (storage, the screens, the board's canvas). Each client registers its own
// once, before it reads the store: the old page in the old page's main.tsx, the app in its bootstrap. Until it does, a seam
// does nothing visible (a kv in memory, a Ui that only logs an error, a board side with no board).
import type { ChatView } from "../types.ts";
import type { Sel } from "../logic/sel.ts";
import type { ConfirmRequest } from "./store.ts";

// ---- the kv port: key-value storage, synchronous, with the page's keys (aiwb.sel, aiwb.widths, aiwb.draft.…)

export type Kv = { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void; keys(): string[] };

const memory = new Map<string, string>();
let kv: Kv = {
  get: (k) => memory.get(k) ?? null,
  set: (k, v) => { memory.set(k, v); },
  remove: (k) => { memory.delete(k); },
  keys: () => [...memory.keys()],
};

/** Sets the storage; the store reads it when it is first read (getState), so this comes before that. */
export function setKv(next: Kv) { kv = next; }
export const theKv = (): Kv => kv;

// ---- the Ui: what the state layer asks of the screens

export type Ui = {
  /** Opens a chat: selects it (and its board) unless something else is chosen already. */
  openChat(c: ChatView): void;
  /** Sets what is on screen: a board, a chat, or neither (the store's `sel`). */
  select(sel: Sel, o?: { ifFree?: boolean; row?: boolean }): void;
  /** Puts the caret in the composer of the chat on screen. */
  focusComposer(): void;
  /** Shows an error the user should see. */
  reportError(title: string, err: unknown): void;
  /** Shows a dialog with actions; Cancel is always there. */
  confirm(req: ConfirmRequest): void;
};

const noUi: Ui = {
  openChat() {}, select() {}, focusComposer() {},
  reportError: (title, err) => { console.error(title, err); },
  confirm() {},
};
let theUi: Ui = noUi;

export function setUi(ui: Ui) { theUi = ui; }
export const ui = (): Ui => theUi;

// ---- the board side: what the event layer asks of the boards (AD-55)

/** A board tool call of an agent, as the server hands it on (an `rpc` event). */
export type ToolCall = { chat: string; branch?: string; board: string; target?: string; name: string; args: any };
export type ToolResult = string | { text: string; image: { mimeType: string; data: string } };

export type BoardSide = {
  /** Runs a board tool (read_board, get_view, get_image, apply, delete_elements, show_board) and answers its result. */
  runTool(call: ToolCall): Promise<ToolResult>;
  /** Writes every board this window holds (of one server's section, with a server); answers when written. */
  flushAll(server?: string): Promise<void>;
  /** Another window took a board: its canvas gives way. */
  boardLost(id: string): void;
  /** A board was handed to this window (its revision), or given for a tool call. */
  granted(id: string, rev: number): void;
  /** Another window asks for a board: writes it, then lets it go. */
  handOver(id: string): Promise<void>;
  /** A stream of a server opened (this computer's, without a server). */
  streamOpened(server?: string): void;
  /** After a snapshot: takes the board on screen and those with an unsaved edit, if no other window holds them. */
  takeAfterSnapshot(): void;
  /** A section's server is back. */
  sectionBack(server: string): void;
  /** The store let go of a board: drops what the board side kept of it (its scene, its save). */
  forgetBoard(id: string): void;
  /** Whether a board has an edit that waits to be saved. */
  boardUnsaved(id: string): boolean;
};

const noBoard: BoardSide = {
  runTool: () => Promise.reject(new Error("no board here")),
  flushAll: async () => {},
  boardLost() {}, granted() {}, handOver: async () => {}, streamOpened() {}, takeAfterSnapshot() {}, sectionBack() {},
  forgetBoard() {}, boardUnsaved: () => false,
};
let theBoardSide: BoardSide = noBoard;

export function setBoardSide(side: BoardSide) { theBoardSide = side; }
export const boardSide = (): BoardSide => theBoardSide;

// ---- before a reload

let flush: (() => Promise<boolean>) | null = null;

/** Sets what writes everything the client still holds (the boards) and answers true once it is all written. */
export function setFlushBeforeReload(f: () => Promise<boolean>) { flush = f; }
/** Writes what the client holds before the server restarts; true once all of it is written (nothing held: true). */
export const flushBeforeReload = (): Promise<boolean> => (flush ? flush() : Promise.resolve(true));
