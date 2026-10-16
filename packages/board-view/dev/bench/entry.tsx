// The BENCH build of the phone's board page (README.md here; built only with AIWB_BOARD_BENCH=1, never shipped): the shipped page
// exactly as it is, then the bench on top of it. The bench talks to the page as the app does and in no other way.
import "../../src/webview/entry.tsx";
import { installBench } from "./bench.ts";

installBench();
