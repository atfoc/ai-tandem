// Whether the window is laid out as the phone now (AD-72): a board's chat is then a screen over the board, not beside it (AD-71).
import { Dimensions } from "react-native";

import { layoutOf } from "../../ui/breakpoints.ts";

export const onPhone = (): boolean => layoutOf(Dimensions.get("window").width) === "phone";
