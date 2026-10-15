// The parts of the composer that other packages fill (the same idea as screens/chat/parts.tsx): the composer draws the box, the toolbar,
// the lists and the lines, and these places in them are the screens of the packages that come after it. A package registers with
// `setComposerPart(name, value)` from its own `screens/<area>/index.ts`, once, at import (before the first render). Until it does a part
// draws the stand-in here (a plain chip or nothing), so the composer works, fits and is checked without it.
//
//   ImageStrip      K4 (screens/composerimages): the thumbnails above the text and the uploads that run, with the note under them (C-IM). null: no strip.
//   AttachButton    K4: the toolbar's attach button, which never leaves the row (until K4 a button that takes no press, for the geometry). null: none
//                   (the fit leaves it out). `off`: why it adds nothing now.
//   pickImages      K4: the device's picker / the desktop dialog / the file input (AD-26). null: the box takes no image.
//   useQuotes       K5: the quotes of the draft: the count above the box, the float to comment on one, `quote(ref, at)` for ⌘L, `kept()`.
//   quoteSelection  K5: the text selected in a message of the chat, as ⌘L reads it ({ref, at}), an { error } sentence, or null for none.
//   SubagentsChip   S7: the Subagents chip and its popover (C-SS). The toolbar gives it its open state (one list at a time) and measures it.
//   BranchBanner    S8: the banner of a pending move above the box (B-FK). null: none.
import { useSyncExternalStore, type ComponentType, type Dispatch, type ReactNode, type SetStateAction } from "react";

import type { Refused } from "@aiwb/core/logic/chatimage.ts";
import { subChipLabel, subChipTitle, subSettings } from "@aiwb/core/logic/subsettings.ts";
import type { Picked, Slot } from "@aiwb/core/state/uploads.ts";
import type { ChatImage, ChatView, Reference } from "@aiwb/core/types.ts";

import { Text } from "../../ui/Text.tsx";
import { ChipName, TChip, UNTIL_FIRST_MESSAGE } from "./Chip.tsx";
import { AttachStandIn } from "./AttachStandIn.tsx";

export type ImageStripProps = {
  chat: string; branch: string; images: readonly ChatImage[]; uploads: Slot["uploads"]; note: string; again?: unknown; onRemove?: (id: string) => void;
};
export type AttachButtonProps = { off: string; onPress(): void };
export type SubagentsProps = {
  c: ChatView;
  /** Why the settings cannot be changed ("" while they can): the chip is then fixed and opens nothing. */
  fixed: string;
  /** The composer sends, or another change is being saved: the chip opens nothing. */
  disabled: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onBusy(busy: boolean): void;
  onError(msg: string): void;
};

/** What a quote hook gives the composer (the old page's Quotes.tsx ComposerQuotes). `at` is whatever `quoteSelection` gave with the reference. */
export type ComposerQuotes = {
  quote(r: Reference, at?: unknown): void;
  /** The count of the draft's quotes, which opens their list; null when there are none. */
  count: ReactNode;
  /** The float at the passage being commented on, if one is open. */
  float: ReactNode;
  /** The draft's quotes as a click elsewhere would leave them (with the comment typed in an open float). */
  kept(): Reference[];
};
/** `width`: the composer's now (0 before it is known), for the count, which leaves its word out when the composer is narrow. */
export type QuotesHook = (o: { chat: string; quotes: Reference[]; setQuotes: Dispatch<SetStateAction<Reference[]>>; readOnly: boolean; width?: number }) => ComposerQuotes;
export type QuoteSelection = { ref: Reference; at?: unknown } | { error: string } | null;

export type ComposerParts = {
  ImageStrip: ComponentType<ImageStripProps> | null;
  AttachButton: ComponentType<AttachButtonProps> | null;
  pickImages: (() => Promise<{ files: Picked[]; skipped: Refused[] }>) | null;
  useQuotes: QuotesHook;
  quoteSelection: (chat: string) => QuoteSelection;
  SubagentsChip: ComponentType<SubagentsProps>;
  BranchBanner: ComponentType<{ chat: string }> | null;
};

/** The Subagents chip until S7 draws it: the settings in words, fixed (no list). */
function SubagentsStandIn({ c, fixed }: SubagentsProps) {
  const s = subSettings(c);
  return (
    <TChip kind="subagents" title={subChipTitle(s, fixed || UNTIL_FIRST_MESSAGE)}>
      <Text size={12} tone="faint">Subagents</Text><ChipName muted>{subChipLabel(s)}</ChipName>
    </TChip>
  );
}

let parts: ComposerParts = {
  ImageStrip: null, AttachButton: AttachStandIn, pickImages: null,
  useQuotes: ({ quotes }) => ({ quote() {}, count: null, float: null, kept: () => quotes }),
  quoteSelection: () => null,
  SubagentsChip: SubagentsStandIn,
  BranchBanner: null,
};
const listeners = new Set<() => void>();

/** Registers a part (once, at import: before the first render). */
export function setComposerPart<K extends keyof ComposerParts>(name: K, value: ComposerParts[K]): void {
  parts = { ...parts, [name]: value };
  for (const l of listeners) l();
}

/** The parts now. */
export function useComposerParts(): ComposerParts {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => parts);
}

/** The parts now, outside a component (a handler). */
export const composerParts = (): ComposerParts => parts;
