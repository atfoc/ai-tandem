// Tool cards and permission cards of the thread (package S6; B-TC, B-PM): registered in the parts of the chat view (screens/chat/parts.tsx),
// which draws a stand-in until this is imported (screens/register.ts).
import { setChatPart } from "../chat/parts.tsx";
import { registerScreen } from "../shell/screens.ts";
import { DIFF_SCREEN, type DiffParams } from "./diff.ts";
import { DiffScreen } from "./DiffScreen.tsx";
import { PermCard } from "./PermCard.tsx";
import { StepGroup } from "./StepGroup.tsx";
import { PermDock } from "./PermDock.tsx";
import { ToolCard } from "./ToolCard.tsx";

setChatPart("ToolCard", ToolCard);
setChatPart("PermCard", PermCard);
setChatPart("StepGroup", StepGroup);
setChatPart("AboveComposer", PermDock);
registerScreen<DiffParams>(DIFF_SCREEN, { kind: "content", title: (p) => p.file, component: DiffScreen });

export { PermCard } from "./PermCard.tsx";
export { ToolCard } from "./ToolCard.tsx";
