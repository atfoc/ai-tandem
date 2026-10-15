// Tool cards and permission cards of the thread (package S6; B-TC, B-PM): registered in the parts of the chat view (screens/chat/parts.tsx),
// which draws a stand-in until this is imported (screens/register.ts).
import { setChatPart } from "../chat/parts.tsx";
import { PermCard } from "./PermCard.tsx";
import { ToolCard } from "./ToolCard.tsx";

setChatPart("ToolCard", ToolCard);
setChatPart("PermCard", PermCard);

export { PermCard } from "./PermCard.tsx";
export { ToolCard } from "./ToolCard.tsx";
