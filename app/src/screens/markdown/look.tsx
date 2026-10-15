import { createContext, useContext } from "react";

import type { Look } from "./look.ts";

export const LookContext = createContext<Look>({ size: 13, color: "#000000", user: false });
export const useLook = () => useContext(LookContext);
