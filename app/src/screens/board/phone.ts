// Whether the window is laid out as the phone now (AD-72): a board's chat is then a screen over the board, not beside it (AD-71).
import { windowLayout } from "../../ui/useLayout.ts";

export const onPhone = (): boolean => windowLayout() === "phone";
