// The app's one board side (AD-55): created here, registered as the store's BoardSide by the bootstrap, and given its view by the
// board screen (B4: `boardApp.attachView`). The selection helpers (nav.ts) and the lifecycle hooks (bootstrap.ts) go through it.
import { createBoardSide } from "@aiwb/core/board/side.ts";

export const boardApp = createBoardSide();
