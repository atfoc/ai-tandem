// The keys port (AD-73): what a shortcut handler is given. The shape is the part of a KeyboardEvent that
// logic/keys.ts, layout.ts isSideKey, newchatwhere.ts isNewChatKey, insert.ts isInsertKey and treepopup.ts read; on web it
// is the KeyboardEvent itself, on the native platforms the object the aiwb-keys module emits.
export type KeyLike = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  /** Takes the key: the system does not also act on it (the page's shortcut owns it). A no-op where there is nothing to prevent. */
  preventDefault(): void;
  stopPropagation(): void;
  /** True once a handler has taken the key (preventDefault was called). */
  readonly defaultPrevented: boolean;
};

/** A shortcut handler; the keys port calls it for every key down, in the order the handlers registered. */
export type KeyHandler = (e: KeyLike) => void;

/** Registers a handler for key presses; returns the function that takes it away. */
export type OnKey = (handler: KeyHandler) => () => void;
