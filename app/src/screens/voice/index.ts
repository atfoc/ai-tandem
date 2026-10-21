// The screens of voice (architecture §3): each file registers one place of the app, as the other areas' `index.ts` do, and this file
// imports them for `screens/register.ts`. Voice's engine and its sentences are in `src/voice`; a screen takes them from `voice/index.ts`
// and `voice/words.ts` only.
import "./settings.ts";
import "./composer.ts";
import "./read.ts";
import "./pill.ts";
import "./devline.ts";

// What the other screens take from voice's screens: the problem popover (a control hangs one next to itself, ProblemPopover.tsx says how).
export { ProblemPopover } from "./ProblemPopover.tsx";
export type { ProblemPopoverProps } from "./ProblemPopover.tsx";
export { ReadAloudProblem } from "./ReadAloud.tsx";
export { SettingsButton } from "./SettingsButton.tsx";
