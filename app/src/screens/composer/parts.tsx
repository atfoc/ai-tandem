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
//   VoiceButtons    voice (VC-17): the Dictate and Speech mode buttons, in the toolbar's row or as two rows of its "more" popup (`place`); `disabled`:
//                   why the composer cannot send now ("" while it can). null: none (the fit leaves them out).
//   SpeechBar       voice (VC-17): the speech bar that takes the place of the box and the toolbar while speech mode is on. null: none.
//   VoiceNotice     voice devices (VD-14): the one-sentence line above the box, the speech bar or the archived bar, where ModelNotice stands: a device
//                   that was missing or went away, or Read aloud's pause. Nothing at rest. null: none.
//
// The phone's composer (ux-improvements package C1, goal 3.6) adds:
//   VoiceControl    voice: one of the two voice controls alone, for the phone's toolbar: `which` "dictate" (the mic) or "talk" (speech mode, the
//                   primary button while the box is empty). It holds the logic and the problem popover's anchor; the composer draws the look
//                   through `children`. null: none (the phone draws no mic, and Send in Talk's place).
//   takePhoto       the camera (Take photo in the "+" sheet), as `pickImages` answers. null: no camera here (the row is not shown).
//   pickFiles       the files of the device (Files in the "+" sheet), as `pickImages` answers. null: no such picker here (the row is not shown).
//   useBlock        package V1 (Blocked.tsx, registered by this folder's index.ts): what blocks sending on the phone (goal 3.7.1, the V1 design §1): `box`
//                   replaces the box and the chip row (archived, old board connection, no agent), `toolbar` stands in the toolbar's place inside the
//                   read-only box (offline, gone), `above` right above the box (a model too small, a refused send), `sendOff` greys Send with its
//                   reason. null: nothing blocks it. A hook, called on every render of the phone's composer (PhoneComposer.tsx).
import { useSyncExternalStore, type ComponentType, type Dispatch, type ReactNode, type SetStateAction } from "react";

import type { Refused } from "@aiwb/core/logic/chatimage.ts";
import type { Where } from "@aiwb/core/logic/chatserver.ts";
import { subChipLabel, subChipTitle, subSettings } from "@aiwb/core/logic/subsettings.ts";
import type { Picked, Slot } from "@aiwb/core/state/uploads.ts";
import type { AgentKind, ChatImage, ChatView, Reference } from "@aiwb/core/types.ts";

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

/** What the phone's composer tells `useBlock` (the V1 design §1). */
export type BlockInput = {
  chatId: string;
  branch: string;
  /** The chat's server (logic/chatserver.ts). */
  where: Where;
  /** The server no longer has the chat. */
  gone: boolean;
  /** The agents the chat's server offers. */
  usable: AgentKind[];
  /** The last refused send's sentence ("" none): the composer's `under`. */
  refused: string;
  onDismissRefused(): void;
};
/** What a block draws; every field is optional. */
export type BlockOut = {
  /** Drawn instead of the box and the chip row. */
  box?: ReactNode;
  /** Drawn in the toolbar's place inside the box, which is read-only and greyed with the draft visible. */
  toolbar?: ReactNode;
  /** Drawn right above the box. */
  above?: ReactNode;
  /** Send is greyed, with this reason. */
  sendOff?: string;
};

export type ComposerParts = {
  ImageStrip: ComponentType<ImageStripProps> | null;
  AttachButton: ComponentType<AttachButtonProps> | null;
  pickImages: (() => Promise<{ files: Picked[]; skipped: Refused[] }>) | null;
  useQuotes: QuotesHook;
  quoteSelection: (chat: string) => QuoteSelection;
  SubagentsChip: ComponentType<SubagentsProps>;
  BranchBanner: ComponentType<{ chat: string }> | null;
  VoiceButtons: ComponentType<{ chatId: string; branch: string; place: "row" | "more"; disabled: string }> | null;
  SpeechBar: ComponentType<{ chatId: string; branch: string }> | null;
  VoiceNotice: ComponentType<{ chatId: string }> | null;
  VoiceControl: ComponentType<VoiceControlProps> | null;
  takePhoto: (() => Promise<{ files: Picked[]; skipped: Refused[] }>) | null;
  pickFiles: (() => Promise<{ files: Picked[]; skipped: Refused[] }>) | null;
  useBlock: (o: BlockInput) => BlockOut | null;
};

/** What a voice control gives the look the phone's composer draws: whether it is on (listening into the box / speech mode), the press, and its
 *  label in the goal's words (Dictate, End dictation, Talk, End) — the control's accessibility label. */
export type VoiceControlState = { on: boolean; onPress(): void; label: string; disabled: boolean };
export type VoiceControlProps = {
  chatId: string;
  branch: string;
  which: "dictate" | "talk";
  /** Why the composer cannot send now ("" while it can): the control starts nothing. */
  disabled: string;
  children(s: VoiceControlState): ReactNode;
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
  VoiceButtons: null, SpeechBar: null, VoiceNotice: null,
  VoiceControl: null, takePhoto: null, pickFiles: null,
  useBlock: () => null,
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
